// biome-ignore-all lint/suspicious/noConsole: Explicit live integration report.
// biome-ignore-all lint/suspicious/noMisplacedAssertion: Standalone public API assertions.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

if (process.env.RUN_CROSS_RUNTIME_SMOKE !== '1') {
  console.log('SKIPPED: set RUN_CROSS_RUNTIME_SMOKE=1 for live three-runtime memory verification')
} else {
  const {
    CODEX_MODEL: codexModel,
    DSH_MODEL: dshModel,
    DEEPAGENTS_MODEL: deepModel,
    MEMORY_SERVICE_DIR: coreDir
  } = process.env
  assert(codexModel && dshModel && deepModel && coreDir, 'Set all three models and an installed MEMORY_SERVICE_DIR')
  assert(process.env.MEMORY_MODEL && process.env.DEEPSEEK_API_KEY, 'Set MEMORY_MODEL and DEEPSEEK_API_KEY')
  const { MemoryCoreService, ProjectMemory } = await import('@qingshaner/memory')
  const { RuntimeManager } = await import('@qingshaner/runtime')
  const { CodexRuntime } = await import('@qingshaner/runtime-codex')
  const { DshRuntime } = await import('@qingshaner/runtime-dsh')
  const { DeepAgentsRuntime } = await import('@qingshaner/runtime-deepagents')
  const dir = await mkdtemp(join(tmpdir(), 'cross-runtime-'))
  const tokenName = `MEMORY_SMOKE_${randomUUID().replaceAll('-', '')}`
  process.env[tokenName] = randomUUID()
  const baseUrl = process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com'
  const core = new MemoryCoreService({
    directory: coreDir,
    endpoint: process.env.MEMORY_ENDPOINT ?? 'http://127.0.0.1:18427',
    gatewayApiKeyEnv: tokenName,
    model: { apiKeyEnv: 'DEEPSEEK_API_KEY', baseUrl, name: process.env.MEMORY_MODEL },
    serviceId: 'cross-runtime-smoke'
  })
  let manager: Awaited<ReturnType<typeof RuntimeManager.open>> | undefined
  try {
    const ready = await core.start()
    const memory = new ProjectMemory({
      apiKeyEnv: tokenName,
      endpoint: ready.endpoint,
      serviceId: 'cross-runtime-smoke'
    })
    manager = await RuntimeManager.open({
      dataDir: join(dir, 'db'),
      memory,
      runtimes: [
        new CodexRuntime({ dataDir: join(dir, 'codex'), requestTimeoutMs: 120000 }),
        new DshRuntime({ baseURL: baseUrl, dataDir: join(dir, 'dsh') }),
        new DeepAgentsRuntime({ apiKeyEnv: 'DEEPSEEK_API_KEY', baseUrl, dataDir: join(dir, 'deepagents') })
      ]
    })
    const projectId = randomUUID()
    const isolated = randomUUID()
    await manager.createProject({ id: projectId, name: 'Shared memory' })
    await manager.createProject({ id: isolated, name: 'Isolated memory' })
    const run = async (runtime: string, model: string, project: string, text: string) => {
      assert(manager)
      const session = await manager.createSession({ cwd: dir, model, projectId: project, runtime })
      const input = { requestId: randomUUID(), text }
      const submitted = await manager.run(session.id, input)
      assert.deepEqual(await manager.run(session.id, input), submitted)
      const timeout = setTimeout(() => {
        void manager?.cancel(submitted.runId).catch(() => {})
      }, 120000)
      let reply = ''
      try {
        for await (const { event } of manager.subscribe(submitted.runId)) {
          if (event.type === 'TEXT_MESSAGE_CONTENT') {
            reply += event.delta
          }
          if (event.type === 'CUSTOM' && event.name === 'runtime.approval.requested') {
            for (const approval of await manager.listPendingApprovals(submitted.runId)) {
              if (approval.status === 'pending') {
                await manager.respondApproval(submitted.runId, approval.id, 'deny')
              }
            }
          }
        }
      } finally {
        clearTimeout(timeout)
      }
      const outcome = await manager.getRun(submitted.runId)
      assert.equal(outcome.status, 'succeeded', `${runtime}: ${outcome.error?.code}`)
      return { outcome, reply, runId: submitted.runId, session }
    }
    const marker = `cobalt-${randomUUID().slice(0, 8)}`
    const first = await run(
      'codex',
      codexModel,
      projectId,
      `Remember these durable preferences for this project: I strongly prefer TypeScript, arrow functions, pnpm and Node.js 24. Our release codename is ${marker}. Confirm the codename exactly. Do not call tools.`
    )
    assert(first.reply.includes(marker))
    const deadline = Date.now() + 120000
    while (
      Date.now() < deadline &&
      !(await memory.recall(projectId, 'project release codename TypeScript')).context.includes(marker)
    ) {
      await delay(1000)
    }
    assert.equal((await manager.getMemoryWrite(first.runId))?.status, 'accepted')
    assert(
      (await memory.recall(projectId, 'project release codename TypeScript')).context.includes(marker),
      'Memory extraction did not trigger'
    )
    for (const [runtime, model] of [
      ['dsh', dshModel],
      ['deepagents', deepModel]
    ]) {
      assert(runtime && model)
      const result = await run(
        runtime,
        model,
        projectId,
        'What is our project release codename from recalled memory? Reply with that exact codename. Do not call tools.'
      )
      assert(result.reply.includes(marker), `${runtime} did not use shared project recall`)
      assert.equal((await manager.resumeSession(result.session.id)).nativeSessionId, result.session.nativeSessionId)
    }
    assert.equal((await memory.recall(isolated, 'project release codename TypeScript')).context, '')
    const other = await run(
      'deepagents',
      deepModel,
      isolated,
      'What is our project release codename? If no recalled memory supplies it, reply UNKNOWN. Do not call tools.'
    )
    assert(!other.reply.includes(marker))
    await core.stop()
    const degraded = await run(
      'dsh',
      dshModel,
      projectId,
      'Reply exactly: memory offline, chat works. Do not call tools.'
    )
    assert.equal(degraded.outcome.memoryError?.code, 'MEMORY_RECALL_FAILED')
    console.log(
      JSON.stringify({
        coreVersion: ready.version,
        explicitResume: true,
        memoryOutageChat: true,
        models: { codexModel, deepModel, dshModel },
        projectIsolation: true,
        requestId: true,
        sharedRecall: ['codex → dsh', 'codex → deepagents'],
        status: 'PASS'
      })
    )
  } finally {
    try {
      await manager?.dispose()
    } finally {
      await core.dispose()
      delete process.env[tokenName]
      await rm(dir, { force: true, recursive: true })
    }
  }
}
