// cspell:ignore TDAI Dedup
// biome-ignore-all lint/suspicious/noMisplacedAssertion: Standalone opt-in probe assertions.
// biome-ignore-all lint/style/useNamingConvention: Upstream environment names.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import { projectClient, recallProject, writeOnce } from './probe.ts'

const CORE_COMMIT = '8f2dc830317934e54548472bf62c5999f9bb1202'

async function startGateway(coreDir: string, config: string, scratch: string, endpoint: string, modelKey?: string) {
  let log = ''

  const child = spawn(process.execPath, ['--import', 'tsx', 'src/gateway/server.ts'], {
    cwd: coreDir,
    env: { HOME: scratch, PATH: process.env.PATH, TDAI_GATEWAY_CONFIG: config, TDAI_OTEL_ENABLED: 'false' },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  child.stdout.on('data', (chunk) => {
    log += String(chunk)
  })
  child.stderr.on('data', (chunk) => {
    log += String(chunk)
  })
  const exited = once(child, 'exit')
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) {
      return
    }
    child.kill('SIGTERM')
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000)
    try {
      await exited
    } finally {
      clearTimeout(timer)
    }
  }
  try {
    for (let i = 0; i < 150; i++) {
      if (child.exitCode !== null) {
        throw new Error(
          `Gateway exited ${child.exitCode}: ${(modelKey ? log.replaceAll(modelKey, '[REDACTED]') : log).slice(-6000)}`
        )
      }
      const health = await fetch(`${endpoint}/health`, { signal: AbortSignal.timeout(500) }).catch(() => null)
      if (health?.ok && log.includes('Gateway listening on')) {
        return { stop }
      }
      await delay(100)
    }
    throw new Error(`Gateway not ready: ${(modelKey ? log.replaceAll(modelKey, '[REDACTED]') : log).slice(-6000)}`)
  } catch (error) {
    await stop()
    throw error
  }
}

async function checkGenerated(endpoint: string) {
  const a = projectClient(endpoint, 'project-a')
  const b = projectClient(endpoint, 'project-b')
  const deadline = Date.now() + 60000
  while (Date.now() < deadline) {
    const recalled = await recallProject(a, 'cobalt')
    if (
      recalled.atomic.length > 0 &&
      recalled.scenarios.length > 0 &&
      recalled.core?.toLowerCase().includes('cobalt')
    ) {
      for (const runtime of ['codex', 'dsh', 'deepagents']) {
        // Cobalt was only written by Codex. Other runtime sessions must recall it too.
        const shared = await recallProject(projectClient(endpoint, 'project-a', `${runtime}-session`), 'cobalt')
        assert(shared.atomic.some((memory) => memory.content.toLowerCase().includes('cobalt')))
        assert(shared.core?.toLowerCase().includes('cobalt'))
      }
      const other = await recallProject(b, 'cobalt')
      assert.equal(other.atomic.length, 0)
      assert.equal(other.scenarios.length, 0)
      assert.equal(other.core, null)
      for (const entry of recalled.scenarios) {
        assert.equal((await b.readScenario({ path: entry.path })).content, null)
      }
      return 'PASS: generated L1/L2/L3 and v3 composite recall across runtime sessions; absent in other project'
    }
    await delay(1000)
  }
  return 'UNVERIFIED: L1/L2/L3 generation did not all trigger before 60-second polling deadline'
}

async function checkProfiles(a: ReturnType<typeof projectClient>, b: ReturnType<typeof projectClient>) {
  const own = (await a.readCore()).content ?? ''
  const other = (await b.readCore()).content ?? ''
  assert.match(own, /cobalt/i)
  assert.doesNotMatch(own, /amber/i)
  assert.match(other, /amber/i)
  assert.doesNotMatch(other, /cobalt/i)
}

export async function probeGateway(coreDir: string) {
  const live = process.env.MEMORY_PROBE_LIVE === '1'
  const { TDAI_LLM_API_KEY: modelKey, TDAI_LLM_MODEL: model, TDAI_LLM_BASE_URL: baseUrl } = live ? process.env : {}
  if (live) {
    assert(modelKey && model && baseUrl, 'Live probe requires explicit TDAI_LLM_API_KEY, MODEL and BASE_URL')
  }
  const manifest = JSON.parse(await readFile(join(coreDir, 'package.json'), 'utf8'))
  assert.equal(manifest.version, '1.0.2-beta.1')
  assert.equal(
    createHash('sha256')
      .update(await readFile(join(coreDir, 'src/gateway/server.ts')))
      .digest('hex'),
    '270c8d27f14a206a5be2e87d2e4291eab0ce714b5b50a84de8d0452855a9fdc4',
    'Gateway source differs from pinned Core commit'
  )
  const scratch = await mkdtemp(join(tmpdir(), 'memory-probe-'))
  const portServer = createServer()
  await new Promise<void>((resolve) => portServer.listen(0, '127.0.0.1', resolve))
  const address = portServer.address()
  assert(address && typeof address !== 'string')
  const endpoint = `http://127.0.0.1:${address.port}`
  await new Promise<void>((resolve) => portServer.close(() => resolve()))
  const config = join(scratch, 'gateway.json')
  await writeFile(
    config,
    JSON.stringify({
      data: { baseDir: join(scratch, 'data') },
      deployMode: 'standalone',
      instanceId: 'probe-memory',
      llm: {
        apiKey: modelKey ?? '',
        baseUrl: baseUrl ?? 'http://127.0.0.1:1/v1',
        model: model ?? 'disabled-in-structural-probe'
      },
      memory: {
        bm25: { enabled: true },
        embedding: { provider: 'none' },
        extraction: { enableDedup: false, enabled: live },
        persona: { triggerEveryN: 1 },
        pipeline: {
          enableWarmup: false,
          everyNConversations: 1,
          l1IdleTimeoutSeconds: 1,
          l2DelayAfterL1Seconds: 1,
          l2MaxIntervalSeconds: 2,
          l2MinIntervalSeconds: 1
        },
        recall: { enabled: true },
        storeBackend: 'sqlite'
      },
      server: { apiKey: 'probe-only-token', host: '127.0.0.1', port: address.port },
      stateBackend: 'local'
    })
  )
  let gateway: Awaited<ReturnType<typeof startGateway>> | undefined
  try {
    gateway = await startGateway(coreDir, config, scratch, endpoint, modelKey)
    const a = projectClient(endpoint, 'project-a')
    const b = projectClient(endpoint, 'project-b')
    for (const [runtime, convention] of [
      ['codex', 'cobalt'],
      ['dsh', 'cedar'],
      ['deepagents', 'meadow']
    ]) {
      const result = await writeOnce(
        projectClient(endpoint, 'project-a', `${runtime}-session`),
        `${runtime}-run`,
        `Project A's ${runtime} subsystem is named ${convention}. Remember this exact subsystem name permanently; other subsystems have independent names.`,
        `I will remember the ${convention} convention.`
      )
      assert(result.status === 'accepted')
      assert.equal(result.result.accepted_ids.length, 2)
    }
    assert.equal((await a.queryConversation()).total, 6)
    assert.equal((await b.queryConversation()).total, 0)
    assert.equal((await a.searchConversation({ limit: 5, query: 'cobalt' })).messages.length > 0, true)
    assert.equal((await b.searchConversation({ limit: 5, query: 'cobalt' })).messages.length, 0)
    const generated = live ? await checkGenerated(endpoint) : 'UNVERIFIED: no model configured'
    // Keep generated A untouched in live mode; later pipeline work can update it.
    if (!live) {
      await a.writeCore({ content: 'Project A profile: cobalt.' })
    }
    await b.writeCore({ content: 'Project B profile: amber.' })
    await checkProfiles(a, b)
    const ids = (await a.queryConversation()).messages.map((message) => message.id)
    await gateway.stop()
    gateway = await startGateway(coreDir, config, scratch, endpoint, modelKey)
    assert.deepEqual(
      (await a.queryConversation()).messages.map((message) => message.id),
      ids
    )
    assert.equal((await b.queryConversation()).total, 0)
    await checkProfiles(a, b)
    const duplicate = projectClient(endpoint, 'project-a', 'codex-session')
    await writeOnce(duplicate, 'codex-run', 'Same message IDs', 'This is not a safe retry.')
    assert.equal((await a.queryConversation()).total, 8)
    return {
      compositeRecall: generated,
      core: CORE_COMMIT,
      duplicateIds: 'NOT_IDEMPOTENT',
      extraction: generated,
      l0: 'PASS',
      l1l2: generated,
      node: process.version,
      profiles: 'PASS',
      restart: 'PASS',
      sdk: '1.0.1-beta.1'
    }
  } finally {
    await gateway?.stop()
    await rm(scratch, { force: true, recursive: true })
  }
}
