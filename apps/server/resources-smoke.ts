// biome-ignore-all lint/style/useNamingConvention: Process environment variables.
// biome-ignore-all lint/suspicious/noMisplacedAssertion: Standalone opt-in smoke uses Node assertions.
// biome-ignore-all lint/suspicious/noConsole: Explicit real smoke output.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { launchNitro } from './test/nitro.fixture.ts'

if (process.env.RUN_HTTP_RESOURCE_SMOKE !== '1' || !process.env.CODEX_MODEL) {
  throw new Error('Explicit RUN_HTTP_RESOURCE_SMOKE=1 and CODEX_MODEL required')
}
assert(
  process.env.MEMORY_SERVICE_DIR &&
    process.env.MEMORY_MODEL &&
    process.env.DEEPSEEK_BASE_URL &&
    process.env.DEEPSEEK_API_KEY
)
const dir = await mkdtemp(join(tmpdir(), 'http-resource-smoke-'))
const endpoint = 'http://127.0.0.1:18435'
const projectId = randomUUID()
const server = await launchNitro(join(dir, 'db'), {
  MEMORY_API_KEY: randomUUID(),
  MEMORY_BASE_URL: process.env.DEEPSEEK_BASE_URL,
  MEMORY_ENDPOINT: endpoint,
  MEMORY_MODEL: process.env.MEMORY_MODEL,
  MEMORY_MODEL_API_KEY_ENV: 'DEEPSEEK_API_KEY',
  MEMORY_SERVICE_DIR: process.env.MEMORY_SERVICE_DIR,
  MEMORY_SERVICE_ID: 'http-resource-smoke'
})
const response = (path: string, method = 'GET', body?: unknown) =>
  fetch(server.url + path, {
    headers: { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' },
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  })
const request = async (path: string, method = 'GET', body?: unknown): Promise<Record<string, unknown>> => {
  const result = await response(path, method, body)
  assert(result.ok, `${path}: ${result.status} ${await (result.ok ? Promise.resolve('') : result.text())}`)
  return (await result.json()) as Record<string, unknown>
}
try {
  // Installation is explicitly requested; an existing fixed installation is reused.
  assert.equal((await request('/memory-core/install', 'POST', {})).version, '1.0.2-beta.1')
  assert.equal((await request('/memory-core/start', 'POST', {})).owned, true)
  await request('/projects', 'POST', { id: projectId, name: 'HTTP resource smoke' })
  await mkdir(join(dir, 'docs'))
  await request(`/projects/${projectId}/knowledge/binding`, 'POST', { directory: join(dir, 'docs') })
  await request(`/projects/${projectId}/knowledge/documents`, 'POST', {
    content: 'verification secret: http_v1',
    path: 'proof.md'
  })
  await mkdir(join(dir, 'source'))
  const skill =
    '---\nname: http-proof\ndescription: Verify HTTP-managed project resources.\n---\nUse knowledge_search and knowledge_read to read proof.md, then call prove with its secret. Return the secret.\n'
  await writeFile(join(dir, 'source/SKILL.md'), skill)
  const imported = await request('/skills', 'POST', { source: join(dir, 'source') })
  await request(`/projects/${projectId}/skills/${imported.id}`, 'POST', { enabled: true })
  const audit = join(dir, 'audit.jsonl')
  const local = await request('/mcp', 'POST', {
    args: [resolve(import.meta.dirname, '../../examples/probe-codex/mcp.ts'), 'http_v1', audit],
    command: process.execPath,
    name: 'proof',
    transport: 'stdio'
  })
  await request(`/projects/${projectId}/mcp/${local.id}`, 'POST', { enabled: true })
  const session = await request('/sessions', 'POST', {
    cwd: dir,
    model: process.env.CODEX_MODEL,
    projectId,
    runtime: 'codex'
  })
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Explicit smoke consumes SSE and handles known fixture approvals.
  const run = async (version: string) => {
    const created = await request(`/sessions/${session.id}/runs`, 'POST', {
      text: 'Use $http-proof. Read the current document via knowledge_search then knowledge_read, call prove with the exact document secret, and return it.'
    })
    const stream = await response(`/runs/${created.runId}/events`)
    assert(stream.body)
    let pending = ''
    let text = ''
    for await (const chunk of stream.body.pipeThrough(new TextDecoderStream())) {
      pending += chunk
      while (pending.includes('\n\n')) {
        const index = pending.indexOf('\n\n')
        const frame = pending.slice(0, index)
        pending = pending.slice(index + 2)
        const data = frame
          .split('\n')
          .find((line) => line.startsWith('data: '))
          ?.slice(6)
        if (!data) {
          continue
        }
        const event = JSON.parse(data)
        if (event.type === 'TEXT_MESSAGE_CONTENT') {
          text += event.delta
        }
        if (event.type === 'CUSTOM' && event.name === 'runtime.approval.requested') {
          assert.equal(event.value.kind, 'tool')
          await request(`/runs/${created.runId}/approvals/${event.value.id}`, 'POST', { decision: 'approve' })
        }
      }
    }
    assert.equal((await request(`/runs/${created.runId}`)).status, 'succeeded')
    assert(text.includes(version))
    for (let i = 0; i < 100; i++) {
      const write = await request(`/runs/${created.runId}/memory-write`)
      if (write.status === 'accepted') {
        break
      }
      assert(i < 99, `Memory not accepted: ${write.status}`)
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
  await run('http_v1')
  await request(`/projects/${projectId}/knowledge/documents`, 'PATCH', {
    content: 'verification secret: http_v2',
    path: 'proof.md'
  })
  await request(`/mcp/${local.id}`, 'PATCH', {
    args: [resolve(import.meta.dirname, '../../examples/probe-codex/mcp.ts'), 'http_v2', audit],
    command: process.execPath,
    name: 'proof',
    transport: 'stdio'
  })
  await run('http_v2')
  const records = (await readFile(audit, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  assert(records.some((item) => item.name === 'http_v1' && item.secret === 'http_v1'))
  assert(records.some((item) => item.name === 'http_v2' && item.secret === 'http_v2'))
  const conversations = await request(`/projects/${projectId}/memory/conversations`)
  assert.equal(conversations.total, 4)
  await request(`/skills/${imported.id}`, 'DELETE')
  assert.equal(await readFile(join(dir, 'source/SKILL.md'), 'utf8'), skill)
  assert.equal((await request('/memory-core/stop', 'POST', {})).owned, false)
  assert.equal((await request('/memory-core/start', 'POST', {})).owned, true)
  assert.equal((await request(`/projects/${projectId}/memory/conversations`)).total, 4)
  console.log(
    'VERIFIED: HTTP resource CRUD, same-session updates, native MCP approvals, memory write receipts, fixed Core lifecycle and restart persistence'
  )
} finally {
  await server.close()
  await rm(dir, { force: true, recursive: true })
}
