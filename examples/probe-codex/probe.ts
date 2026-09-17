// cspell:ignore cwds
// biome-ignore-all lint/style/useNamingConvention: Native protocol and environment field names.
// biome-ignore-all lint/suspicious/noMisplacedAssertion: Standalone real-protocol probe.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { Json } from '@qingshaner/runtime'

import { JsonRpcClient } from '../../packages/runtime-codex/src/client'

interface Skill {
  name: string
  path: string
  enabled: boolean
}
const rpc = async <T>(client: JsonRpcClient, method: string, params: Json): Promise<T> =>
  (await client.request(method, params)) as T

/** Runs the pinned native app-server against disposable project homes. */
export async function runProbe() {
  const command = process.env.CODEX_EXECUTABLE ?? 'codex'
  const version = execFileSync(command, ['--version'], { encoding: 'utf8' }).trim()
  assert.equal(version, 'codex-cli 0.153.4', 'Unverified CLI version')
  const model = process.env.CODEX_MODEL
  assert.ok(model, 'Explicit CODEX_MODEL required')
  const root = await realpath(await mkdtemp(join(tmpdir(), 'codex-isolation-')))
  const fixture = join(dirname(fileURLToPath(import.meta.url)), '..', 'mcp.ts')
  const clients: JsonRpcClient[] = []
  const audit = join(root, 'calls.jsonl')
  const fakeHome = join(root, 'user')
  const config = (name: string) =>
    `[features]\napps = false\n\n[mcp_servers.${name}]\ncommand = ${JSON.stringify(process.execPath)}\nargs = ${JSON.stringify([fixture, name, audit])}\n`
  const skill = async (directory: string, name: string, server: string) => {
    const path = join(directory, name, 'SKILL.md')
    const secret = randomUUID()
    await mkdir(dirname(path), { recursive: true })
    await writeFile(
      path,
      `---\nname: ${name}\ndescription: Project isolation proof\n---\nCall the ${server} MCP prove tool exactly once with secret ${secret}. Then finish.\n`
    )
    return { name, path, secret }
  }
  try {
    await mkdir(join(fakeHome, '.codex'), { recursive: true })
    await writeFile(join(fakeHome, '.codex', 'config.toml'), config('unbound'))
    await skill(join(fakeHome, '.agents', 'skills'), 'unbound', 'unbound')
    const projects: {
      client: JsonRpcClient
      cwd: string
      home: string
      selected: { name: string; path: string; secret: string }
      name: string
    }[] = []
    for (const name of ['alpha', 'beta']) {
      const home = join(root, name, 'home')
      const cwd = join(root, name, 'work')
      await mkdir(home, { recursive: true })
      await mkdir(cwd, { recursive: true })
      await copyFile(
        join(process.env.CODEX_AUTH_HOME ?? process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'auth.json'),
        join(home, 'auth.json')
      )
      await chmod(join(home, 'auth.json'), 0o600)
      await writeFile(join(home, 'config.toml'), config(name))
      const selected = await skill(join(root, name, 'skills'), name, name)
      const client = new JsonRpcClient({
        args: ['app-server'],
        command,
        env: { ...process.env, CODEX_HOME: home, HOME: fakeHome },
        requestTimeoutMs: 60_000
      })
      clients.push(client)
      await client.request('initialize', {
        capabilities: { experimentalApi: false },
        clientInfo: { name: 'isolation_probe', version: '1.0.0' }
      })
      await client.notify('initialized', {})
      projects.push({ client, cwd, home, name, selected })
    }
    const select = async (project: (typeof projects)[number], selected: typeof project.selected) => {
      const { client, cwd } = project
      await client.request('skills/extraRoots/set', { extraRoots: [dirname(dirname(selected.path))] })
      const inventory = await rpc<{ data: { skills: Skill[] }[] }>(client, 'skills/list', {
        cwds: [cwd],
        forceReload: true
      })
      for (const entry of inventory.data.flatMap((x) => x.skills)) {
        await client.request('skills/config/write', {
          enabled: entry.path === selected.path,
          name: null,
          path: entry.path
        })
      }
      const active = await rpc<{ data: { skills: Skill[] }[] }>(client, 'skills/list', {
        cwds: [cwd],
        forceReload: true
      })
      assert.deepEqual(
        active.data
          .flatMap((x) => x.skills)
          .filter((x) => x.enabled)
          .map((x) => x.name),
        [selected.name]
      )
    }
    const turn = async (client: JsonRpcClient, threadId: string, selected: { name: string; path: string }) => {
      let remove = () => {}
      let removeExit = () => {}
      let timer: ReturnType<typeof setTimeout> | undefined
      const done = new Promise<void>((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Model turn timed out')), 120_000)
        removeExit = client.onExit(reject)
        const rejectRequests = client.onFrame((frame) => {
          if (frame.kind !== 'server-request') {
            return
          }
          const params = frame.params as { serverName?: string }
          if (
            frame.method === 'mcpServer/elicitation/request' &&
            ['alpha', 'beta', 'alpha_next'].includes(params.serverName ?? '')
          ) {
            void client.reply(frame.id, { _meta: null, action: 'accept', content: {} }).catch(reject)
          } else {
            void client.replyError(frame.id, -32601, 'Unsupported in probe').catch(reject)
          }
        })
        const removeNotification = client.onFrame((frame) => {
          if (frame.kind !== 'notification' || frame.method !== 'turn/completed') {
            return
          }
          const params = frame.params as { threadId: string; turn: { status: string; error?: { message: string } } }
          if (params.threadId !== threadId) {
            return
          }
          if (params.turn.status !== 'completed') {
            reject(new Error('Native turn did not complete'))
            return
          }
          resolve()
        })
        remove = () => {
          rejectRequests()
          removeNotification()
        }
      })
      void done.catch(() => {})
      try {
        await client.request('turn/start', {
          input: [
            { text: `Use the ${selected.name} skill now.`, text_elements: [], type: 'text' },
            { name: selected.name, path: selected.path, type: 'skill' }
          ],
          threadId
        })
        await done
      } finally {
        clearTimeout(timer)
        remove()
        removeExit()
      }
    }
    const results = []
    for (const project of projects) {
      await select(project, project.selected)
      const ids: string[] = []
      for (let i = 0; i < 2; i++) {
        const started = await rpc<{ thread: { id: string } }>(project.client, 'thread/start', {
          approvalPolicy: 'on-request',
          cwd: project.cwd,
          model,
          sandbox: 'read-only'
        })
        ids.push(started.thread.id)
      }
      assert.notEqual(ids[0], ids[1])
      const threadId = ids[0]
      assert.ok(threadId)
      const inventory = await rpc<{ data: { name: string }[] }>(project.client, 'mcpServerStatus/list', {
        limit: 100,
        threadId: threadId
      })
      assert.deepEqual(
        inventory.data.map((x) => x.name),
        [project.name]
      )
      await turn(project.client, threadId, project.selected)
      results.push({ project: project.name, secret: project.selected.secret, threadId: threadId })
    }
    const alpha = projects[0]
    assert.ok(alpha)
    const updated = await skill(join(root, 'alpha', 'updated-skills'), 'alpha-next', 'alpha_next')
    // Preserve the application-owned skill disable settings while changing the MCP binding.
    const original = await readFile(join(alpha.home, 'config.toml'), 'utf8')
    await writeFile(
      join(alpha.home, 'config.toml'),
      original.replace('[mcp_servers.alpha]', '[mcp_servers.alpha_next]').replaceAll('"alpha"', '"alpha_next"')
    )
    await select(alpha, updated)
    await alpha.client.request('config/mcpServer/reload', {})
    await turn(alpha.client, results[0]?.threadId, updated)
    const calls = (await readFile(audit, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    assert.deepEqual(calls, [
      { name: 'alpha', secret: results[0]?.secret },
      { name: 'beta', secret: results[1]?.secret },
      { name: 'alpha_next', secret: updated.secret }
    ])
    return {
      actualSkillAndMcpCalls: calls.length,
      experimentalApi: false,
      model,
      nextTurnUpdate: true,
      projectProcesses: 2,
      status: 'PASS',
      threadsPerProcess: 2,
      version
    }
  } finally {
    await Promise.all(clients.map((client) => client.close()))
    await rm(root, { force: true, recursive: true })
  }
}
