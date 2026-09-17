// biome-ignore-all lint/suspicious/noConsole: Explicit real smoke output.
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { Knowledge } from '@qingshaner/knowledge'
import { Mcp } from '@qingshaner/mcp'
import { ProjectResources, RuntimeManager } from '@qingshaner/runtime'
import { CodexRuntime } from '@qingshaner/runtime-codex'
import { Skills } from '@qingshaner/skill'

if (process.env.RUN_RESOURCE_SMOKE !== '1' || !process.env.CODEX_MODEL) {
  throw new Error('Set RUN_RESOURCE_SMOKE=1 and CODEX_MODEL explicitly')
}
const dir = await mkdtemp(join(tmpdir(), 'resource-smoke-'))
const audit = join(dir, 'audit.jsonl')
const httpCalls: string[] = []
const peers = new Set<Server>()
const http = createServer((request, response) => {
  void (async () => {
    const server = new Server({ name: 'http-smoke', version: '1.0.0' }, { capabilities: { tools: {} } })
    peers.add(server)
    response.once('close', () => {
      peers.delete(server)
      void server.close()
    })
    server.setRequestHandler(ListToolsRequestSchema, () =>
      Promise.resolve({
        tools: [
          {
            description: 'Record the secret learned from the project skill.',
            inputSchema: { properties: { secret: { type: 'string' } }, required: ['secret'], type: 'object' },
            name: 'http_prove'
          }
        ]
      })
    )
    server.setRequestHandler(CallToolRequestSchema, ({ params }) => {
      httpCalls.push(String(params.arguments?.secret))
      return Promise.resolve({ content: [{ text: 'HTTP proof recorded', type: 'text' }] })
    })
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true, sessionIdGenerator: undefined })
    await server.connect(transport)
    await transport.handleRequest(request, response)
  })().catch(() => response.destroy())
})
http.listen(0, '127.0.0.1')
await once(http, 'listening')
const address = http.address()
assert(address && typeof address !== 'string')
const knowledge = await Knowledge.open(join(dir, 'knowledge'))
const skills = await Skills.open(join(dir, 'skills'))
const mcp = await Mcp.open(join(dir, 'mcp'))
const resources = new ProjectResources({ knowledge, mcp, skills })
const manager = await RuntimeManager.open({
  dataDir: join(dir, 'db'),
  resources,
  runtimes: [new CodexRuntime({ dataDir: join(dir, 'codex'), requestTimeoutMs: 120000 })]
})
const skillText = (name: string, secret: string) =>
  `---\nname: ${name}\ndescription: Follow this skill for project resource verification.\n---\nUse knowledge_search for verification then knowledge_read of proof.md. Call prove with the document secret. Call http_prove with this skill secret: ${secret}. Include both secrets in the final answer.\n`
try {
  const remote = await mcp.create({ name: 'http', transport: 'http', url: `http://127.0.0.1:${address.port}/mcp` })
  const sessions: Record<string, string> = {}
  const imported: Record<string, string> = {}
  const localIds: Record<string, string> = {}
  for (const name of ['alpha', 'beta']) {
    const cwd = join(dir, name)
    await mkdir(cwd)
    await mkdir(join(dir, `${name}-docs`))
    await knowledge.bind(name, join(dir, `${name}-docs`))
    await knowledge.create(name, 'proof.md', `verification secret: ${name}_doc_v1`)
    await mkdir(join(dir, `${name}-source`))
    await writeFile(join(dir, `${name}-source/SKILL.md`), skillText(`${name}-proof`, `${name}_skill_v1`))
    const skill = await skills.import(join(dir, `${name}-source`))
    imported[name] = skill.id
    await skills.bind(name, skill.id, true)
    const local = await mcp.create({
      args: [resolve(import.meta.dirname, '../probe-codex/mcp.ts'), name, audit],
      command: process.execPath,
      name: `${name}_stdio`,
      transport: 'stdio'
    })
    localIds[name] = local.id
    await mcp.bind(name, local.id, true)
    await mcp.bind(name, remote.id, true)
    await manager.createProject({ id: name, name })
    const session = await manager.createSession({
      cwd,
      model: process.env.CODEX_MODEL,
      projectId: name,
      runtime: 'codex'
    })
    sessions[name] = session.id
  }
  const run = async (name: string, version: string) => {
    const sessionId = sessions[name]
    assert(sessionId)
    const { runId } = await manager.run(sessionId, {
      text: `Use $${name}-proof to verify the project resources now. Execute project_resources.prove with the document secret and project_resources.http_prove with the skill secret, each exactly once. First use knowledge_search then knowledge_read. Read current skill and document contents; do not reuse earlier secrets. Return both current secrets.`
    })
    const events = []
    for await (const envelope of manager.subscribe(runId)) {
      events.push(envelope)
      if (envelope.event.type === 'CUSTOM' && envelope.event.name === 'runtime.approval.requested') {
        for (const approval of await manager.listPendingApprovals(runId)) {
          assert(approval.kind === 'tool' && approval.detail.serverName === 'project_resources')
          await manager.respondApproval(runId, approval.id, 'approve')
        }
      }
    }
    const outcome = await manager.getRun(runId)
    assert.equal(outcome.status, 'succeeded', JSON.stringify(outcome.error))
    const calls = events.flatMap(({ event }) => (event.type === 'TOOL_CALL_START' ? [event.toolCallName] : []))
    for (const tool of ['knowledge_search', 'knowledge_read', 'prove', 'http_prove']) {
      assert(
        calls.some((name) => name.endsWith(`.${tool}`)),
        `Missing ${tool}: ${calls}`
      )
    }
    const text = events.flatMap(({ event }) => (event.type === 'TEXT_MESSAGE_CONTENT' ? [event.delta] : [])).join('')
    assert(text.includes(`${name}_doc_${version}`))
    assert(text.includes(`${name}_skill_${version}`))
    assert(!text.includes(name === 'alpha' ? 'beta_doc' : 'alpha_doc'))
    console.log(`VERIFIED: ${name} ${version} knowledge search/read, skill and stdio/HTTP MCP`)
  }
  await run('alpha', 'v1')
  await run('beta', 'v1')
  await knowledge.edit('alpha', 'proof.md', 'verification secret: alpha_doc_v2')
  await manager.updateProjectResources('alpha', async () => {
    const id = imported.alpha
    const localId = localIds.alpha
    assert(id && localId)
    await skills.edit(id, 'SKILL.md', skillText('alpha-proof', 'alpha_skill_v2'))
    await mcp.update(localId, {
      args: [resolve(import.meta.dirname, '../probe-codex/mcp.ts'), 'alpha_updated', audit],
      command: process.execPath,
      name: 'alpha_stdio',
      transport: 'stdio'
    })
  })
  await run('alpha', 'v2')
  const records = (await readFile(audit, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  for (const [name, secret] of [
    ['alpha', 'alpha_doc_v1'],
    ['beta', 'beta_doc_v1'],
    ['alpha_updated', 'alpha_doc_v2']
  ]) {
    assert(records.some((record) => record.name === name && record.secret === secret))
  }
  for (const secret of ['alpha_skill_v1', 'beta_skill_v1', 'alpha_skill_v2']) {
    assert(httpCalls.includes(secret))
  }
  console.log('VERIFIED: project isolation and existing session after drained native resource reload')
} finally {
  await manager.dispose()
  await mcp.dispose()
  await Promise.all([...peers].map((server) => server.close()))
  http.closeAllConnections()
  await new Promise<void>((resolve) => http.close(() => resolve()))
  await rm(dir, { force: true, recursive: true })
}
