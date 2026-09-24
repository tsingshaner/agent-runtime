// cspell:ignore cwds
// biome-ignore-all lint/style/useNamingConvention: Native protocol uses snake_case configuration keys.
// biome-ignore-all lint/suspicious/noMisplacedAssertion: Vitest test.skipIf is a test function.
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { RuntimeManager } from '@qingshaner/runtime'
import { expect, test, vi } from 'vitest'

import { JsonRpcClient } from '../src/client'
import { CodexRuntime } from '../src/runtime'

test('shares processes within a project, isolates failures and resumes from owned homes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-projects-'))
  const auth = join(dir, 'auth')
  await mkdir(auth)
  await writeFile(join(auth, 'auth.json'), '{"fixture":"authentication"}')
  await writeFile(join(auth, 'config.toml'), '[mcp_servers.unbound]\ncommand="never-run"\n')
  const audit = join(dir, 'audit.jsonl')
  const makeRuntime = (dataDir = join(dir, 'native')) =>
    new CodexRuntime({
      codexHome: auth,
      dataDir,
      executable: {
        args: [fileURLToPath(new URL('./project-app-server.mjs', import.meta.url)), audit],
        command: process.execPath
      }
    })
  let runtime = makeRuntime()
  let manager = await RuntimeManager.open({ dataDir: join(dir, 'manager'), runtimes: [runtime] })
  const records = async (): Promise<
    { pid: number; home: string; userHome: string; method: string; params: Record<string, unknown> }[]
  > =>
    (await readFile(audit, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
  try {
    const a = await manager.createProject({ name: 'A' })
    const b = await manager.createProject({ name: 'B' })
    const create = (projectId: string) =>
      manager.createSession({ cwd: dir, model: 'test', projectId, runtime: 'codex' })
    const [a1, a2, b1] = await Promise.all([create(a.id), create(a.id), create(b.id)])
    const starts = (await records()).filter(({ method }) => method === 'thread/start')
    expect(new Set(starts.map(({ pid }) => pid)).size).toBe(2)
    expect(new Set(starts.map(({ home }) => home)).size).toBe(2)
    for (const record of starts) {
      expect(record.params.config).toEqual({ features: { apps: false }, mcp_servers: { unbound: { enabled: false } } })
      expect(record.home).not.toBe(auth)
      expect(record.userHome).not.toBe(process.env.HOME)
      expect(await readFile(join(record.home, 'config.toml'), 'utf8')).not.toContain('never-run')
    }
    const first = await manager.run(a1.id, { text: 'hold' })
    const other = await manager.run(b1.id, { text: 'hold' })
    await vi.waitFor(async () => expect((await manager.getRun(other.runId)).nativeTurnId).not.toBeNull())
    await vi.waitFor(async () => expect((await manager.getRun(first.runId)).nativeTurnId).not.toBeNull())
    await manager.cancel(first.runId)
    await Array.fromAsync(manager.subscribe(first.runId))
    expect((await manager.getRun(other.runId)).status).toBe('running')
    expect((await records()).filter(({ method }) => method === 'initialize')).toHaveLength(2)
    const shared = await manager.run(a1.id, { text: 'hold' })
    await vi.waitFor(async () => expect((await manager.getRun(shared.runId)).nativeTurnId).not.toBeNull())
    const crashing = await manager.run(a2.id, { text: 'crash' })
    await Promise.all([shared, crashing].map(({ runId }) => Array.fromAsync(manager.subscribe(runId))))
    expect((await manager.getRun(shared.runId)).status).toBe('failed')
    expect((await manager.getRun(other.runId)).status).toBe('running')
    await manager.resumeSession(a1.id)
    expect((await records()).filter(({ method }) => method === 'initialize')).toHaveLength(3)
    await manager.dispose()
    for (const pid of new Set((await records()).map((row) => row.pid))) {
      expect(() => process.kill(pid, 0)).toThrow()
    }
    runtime = makeRuntime()
    manager = await RuntimeManager.open({ dataDir: join(dir, 'manager'), runtimes: [runtime] })
    expect((await manager.resumeSession(a1.id)).nativeSessionId).toBe(a1.nativeSessionId)
    await manager.dispose()
    const original = join(dir, 'native', createHash('sha256').update(a.id).digest('hex'), 'codex', 'sessions')
    await cp(original, join(auth, 'sessions'), { recursive: true })
    runtime = makeRuntime(join(dir, 'migrated'))
    manager = await RuntimeManager.open({ dataDir: join(dir, 'manager'), runtimes: [runtime] })
    expect((await manager.resumeSession(a1.id)).nativeSessionId).toBe(a1.nativeSessionId)
    await manager.dispose()
    const migrated = join(dir, 'migrated', createHash('sha256').update(a.id).digest('hex'), 'codex', 'sessions')
    await rm(join(migrated, `rollout-fixture-${a1.nativeSessionId}.jsonl`))
    runtime = makeRuntime(join(dir, 'migrated'))
    manager = await RuntimeManager.open({ dataDir: join(dir, 'manager'), runtimes: [runtime] })
    await expect(manager.resumeSession(a1.id)).rejects.toMatchObject({ code: 'RPC_ERROR' })
    expect(await readFile(join(auth, 'config.toml'), 'utf8')).toContain('never-run')
  } finally {
    await manager.dispose()
    await rm(dir, { force: true, recursive: true })
  }
})

test.skipIf(process.env.RUN_CODEX_PROJECT_SMOKE !== '1')(
  'real CLI isolates resources and resumes owned and legacy history without a model turn',
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-project-native-'))
    const cwd = join(dir, 'work')
    const auth = join(dir, 'caller')
    const skill = join(cwd, '.agents', 'skills', 'unbound')
    await mkdir(skill, { recursive: true })
    await mkdir(auth)
    await writeFile(join(skill, 'SKILL.md'), '---\nname: unbound\ndescription: Must not be enabled\n---\nDo not run.\n')
    const config = '[mcp_servers.unbound]\ncommand="never-run"\n'
    await writeFile(join(auth, 'config.toml'), config)
    const options = { codexHome: auth, dataDir: join(dir, 'owned'), requestTimeoutMs: 30000 }
    const requests = vi.spyOn(JsonRpcClient.prototype, 'request')
    let runtime = new CodexRuntime(options)
    try {
      const session = await runtime.createSession({ cwd, model: 'gpt-6-astra', projectId: 'project' })
      const client = requests.mock.contexts.at(-1) as JsonRpcClient | undefined
      if (!client) {
        throw new Error('Missing transport')
      }
      const skills = (await client.request('skills/list', { cwds: [cwd], forceReload: true })) as {
        data: { skills: { enabled: boolean }[] }[]
      }
      expect(skills.data.flatMap((item) => item.skills).filter(({ enabled }) => enabled)).toEqual([])
      const servers = (await client.request('mcpServerStatus/list', {
        limit: 100,
        threadId: session.nativeSessionId
      })) as { data: unknown[] }
      expect(servers.data).toEqual([])
      const later = join(cwd, '.agents', 'skills', 'later')
      await mkdir(later)
      await writeFile(
        join(later, 'SKILL.md'),
        '---\nname: later\ndescription: Added after creation\n---\nDo not run.\n'
      )
      await runtime.createSession({ cwd, model: 'gpt-6-astra', projectId: 'project' })
      const refreshed = (await client.request('skills/list', { cwds: [cwd], forceReload: true })) as typeof skills
      expect(refreshed.data.flatMap((item) => item.skills).filter(({ enabled }) => enabled)).toEqual([])
      await client.request('thread/inject_items', {
        items: [{ content: [{ text: 'Persistence fixture', type: 'input_text' }], role: 'user', type: 'message' }],
        threadId: session.nativeSessionId
      })
      await runtime.dispose()
      runtime = new CodexRuntime(options)
      await runtime.resumeSession(session)
      const home = join(options.dataDir, createHash('sha256').update('project').digest('hex'), 'codex')
      await runtime.dispose()
      await cp(join(home, 'sessions'), join(auth, 'sessions'), { recursive: true })
      runtime = new CodexRuntime({ ...options, dataDir: join(dir, 'migrated') })
      await runtime.resumeSession(session)
      expect(await readFile(join(auth, 'config.toml'), 'utf8')).toBe(config)
    } finally {
      requests.mockRestore()
      await runtime.dispose()
      await rm(dir, { force: true, recursive: true })
    }
  },
  60000
)
