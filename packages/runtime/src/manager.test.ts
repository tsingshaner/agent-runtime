import { mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { EventType } from '@ag-ui/core'
import { sql } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest'

import { ManualAdapter } from '../test/manual-adapter'
import { RuntimeError } from './errors'
import { acquireDirectoryLock } from './lock'
import { RuntimeManager } from './manager'

import type { SessionStore } from './store'
import type { EventEnvelope, JsonObject } from './types'

const collect = async (events: AsyncIterable<EventEnvelope>): Promise<EventEnvelope[]> => {
  const result: EventEnvelope[] = []
  for await (const event of events) {
    result.push(event)
  }
  return result
}

describe('RuntimeManager operations', () => {
  let dir: string
  let adapter: ManualAdapter
  let manager: RuntimeManager

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'runtime-manager-'))
    adapter = new ManualAdapter()
    manager = await RuntimeManager.open({ dataDir: dir, runtimes: [adapter] })
    if ((await manager.listProjects()).items.length === 0) {
      await manager.createProject({ id: 'project', name: 'project' })
    }
  })

  afterEach(async () => {
    // Test-only access: await the manager's final persistence and cleanup, not just the terminal event.
    const active = Reflect.get(manager, 'active') as Map<string, { done: Promise<void> }>
    const pending = [...active.values()].map(({ done }) => done)
    await Promise.all([...active.keys()].map((runId) => manager.cancel(runId)))
    await Promise.all(pending)
    const store = Reflect.get(manager, 'store') as SessionStore
    await store.db.execute(sql`TRUNCATE TABLE input_requests, approvals, events, runs, sessions`)
    adapter.reset()
    await Promise.all(['alias', 'file.txt'].map((name) => rm(join(dir, name), { force: true })))
  })

  afterAll(async () => {
    try {
      await manager.dispose()
    } finally {
      await rm(dir, { force: true, recursive: true })
    }
  })

  const create = () =>
    manager.createSession({ cwd: dir, model: 'model-test', projectId: 'project', runtime: adapter.kind })

  test('keeps a run executing without subscribers', async () => {
    const session = await create()
    const { runId } = await manager.run(session.id, { text: 'hello' })
    await adapter.waitStarted(runId)

    await expect(manager.run(session.id, { text: 'second' })).rejects.toMatchObject({ code: 'SESSION_BUSY' })
    adapter.finish(runId, { status: 'succeeded' })
    const events = await collect(manager.subscribe(runId))

    expect(events.map(({ event }) => event.type)).toEqual([EventType.RUN_STARTED, EventType.RUN_FINISHED])
    expect(await manager.getRun(runId)).toMatchObject({ sessionId: session.id, status: 'succeeded' })
  })

  test('starts separate sessions concurrently', async () => {
    const first = await create()
    const second = await create()
    const runs = await Promise.all([manager.run(first.id, { text: 'one' }), manager.run(second.id, { text: 'two' })])
    await Promise.all(runs.map(({ runId }) => adapter.waitStarted(runId)))

    expect((await manager.getSession(first.id)).activeRunId).toBe(runs[0]?.runId)
    expect((await manager.getSession(second.id)).activeRunId).toBe(runs[1]?.runId)
    for (const { runId } of runs) {
      adapter.finish(runId, { status: 'succeeded' })
    }
    await Promise.all(runs.map(({ runId }) => collect(manager.subscribe(runId))))
  })

  test('persists native turn and emitted events before acknowledging delivery', async () => {
    const session = await create()
    const { runId } = await manager.run(session.id, { text: '  hello\nworld  ' })
    await adapter.waitStarted(runId)
    await adapter.push(runId, { kind: 'started', nativeTurnId: 'turn-1' })
    await adapter.push(runId, { event: { name: 'test.progress', type: EventType.CUSTOM, value: 42 }, kind: 'event' })

    expect(await manager.getRun(runId)).toMatchObject({ lastSequence: 2, nativeTurnId: 'turn-1', status: 'running' })
    expect(adapter.executions.get(runId)).toEqual({ runId, sessionId: session.id, text: '  hello\nworld  ' })
    adapter.finish(runId, { status: 'succeeded' })
    const events = await collect(manager.subscribe(runId, { afterSequence: 1 }))
    expect(events.map(({ sequence }) => sequence)).toEqual([2, 3])
    expect(events[0]?.event).toEqual({ name: 'test.progress', type: EventType.CUSTOM, value: 42 })
  })

  test('keeps execution alive after a subscriber disconnects', async () => {
    const session = await create()
    const { runId } = await manager.run(session.id, { text: 'hello' })
    await adapter.waitStarted(runId)
    const controller = new AbortController()
    const iterator = manager.subscribe(runId, { signal: controller.signal })[Symbol.asyncIterator]()
    await iterator.next()
    controller.abort()
    expect((await iterator.next()).done).toBe(true)

    await adapter.push(runId, { kind: 'started', nativeTurnId: 'still-running' })
    adapter.finish(runId, { status: 'succeeded' })
    expect((await collect(manager.subscribe(runId))).at(-1)?.event.type).toBe(EventType.RUN_FINISHED)
    expect(adapter.cancelled).toEqual([])
  })

  test('stores canonical native session data and defaults the title to project', async () => {
    const alias = join(dir, 'alias')
    await symlink(dir, alias)
    const session = await manager.createSession({
      cwd: alias,
      model: 'model-test',
      projectId: 'project',
      runtime: adapter.kind
    })

    expect(session).toMatchObject({
      cwd: await realpath(dir),
      nativeSessionId: 'native-1',
      options: { model: 'test-model' },
      title: 'project'
    })
    expect(session.id).not.toBe(session.nativeSessionId)
    expect(await manager.resumeSession(session.id)).toEqual(session)
    expect((await manager.listSessions({ projectId: 'project' })).items).toEqual([session])
  })

  test('prevents archived execution until the session is restored', async () => {
    const session = await create()
    await manager.archiveSession(session.id)
    await expect(manager.run(session.id, { text: 'hello' })).rejects.toMatchObject({ code: 'SESSION_ARCHIVED' })
    await manager.unarchiveSession(session.id)
    const { runId } = await manager.run(session.id, { text: 'hello' })
    await adapter.waitStarted(runId)
    adapter.finish(runId, { status: 'succeeded' })
    await collect(manager.subscribe(runId))
  })

  test('rejects a native identifier rather than importing it', async () => {
    const session = await create()
    await expect(manager.resumeSession(session.nativeSessionId)).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' })
    await expect(manager.run(session.nativeSessionId, { text: 'hello' })).rejects.toMatchObject({
      code: 'SESSION_NOT_FOUND'
    })
    expect(adapter.resumed).toEqual([])
  })

  test('clears terminal events while retaining the run index', async () => {
    const session = await create()
    const { runId } = await manager.run(session.id, { text: 'hello' })
    await adapter.waitStarted(runId)
    adapter.finish(runId, { status: 'succeeded' })
    await collect(manager.subscribe(runId))
    await manager.clearRunEvents(runId)

    expect((await manager.listRuns(session.id)).items).toMatchObject([
      { eventsCleared: true, id: runId, status: 'succeeded' }
    ])
    await expect(collect(manager.subscribe(runId))).rejects.toMatchObject({ code: 'EVENTS_CLEARED' })
  })

  test.each(['', ' \n '])('rejects empty run text %j before reserving a run', async (text) => {
    const session = await create()
    await expect(manager.run(session.id, { text })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect((await manager.listRuns(session.id)).items).toEqual([])
  })

  test.each([
    { projectId: '' },
    { projectId: '   ' },
    { title: 'x'.repeat(257) },
    { options: { invalid: undefined } },
    { extra: true }
  ])('rejects invalid creation input %j before native creation', async (invalid) => {
    await expect(
      manager.createSession({
        cwd: dir,
        model: 'model-test',
        projectId: 'project',
        runtime: adapter.kind,
        ...invalid
      } as never)
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(adapter.created).toEqual([])
  })

  test('rejects a missing cwd or a regular file before native creation', async () => {
    const file = join(dir, 'file.txt')
    await writeFile(file, 'content')
    for (const cwd of [file, join(dir, 'missing')]) {
      await expect(
        manager.createSession({ cwd, model: 'model-test', projectId: 'project', runtime: adapter.kind })
      ).rejects.toMatchObject({
        code: 'INVALID_INPUT'
      })
    }
    expect(adapter.created).toEqual([])
  })
})

describe('RuntimeManager lifecycle', () => {
  let dir: string
  let adapter: ManualAdapter
  let manager: RuntimeManager

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'runtime-manager-'))
    adapter = new ManualAdapter()
    manager = await RuntimeManager.open({ dataDir: dir, runtimes: [adapter] })
    if ((await manager.listProjects()).items.length === 0) {
      await manager.createProject({ id: 'project', name: 'project' })
    }
  })

  afterEach(async () => {
    await manager.dispose()
    await rm(dir, { force: true, recursive: true })
  })

  const create = () =>
    manager.createSession({ cwd: dir, model: 'model-test', projectId: 'project', runtime: adapter.kind })

  test('queries old sessions without their adapter and rejects execution', async () => {
    const session = await create()
    await manager.dispose()
    manager = await RuntimeManager.open({ dataDir: dir, runtimes: [] })

    expect(await manager.getSession(session.id)).toEqual(session)
    expect((await manager.listSessions()).items).toEqual([session])
    await expect(manager.run(session.id, { text: 'hello' })).rejects.toMatchObject({ code: 'RUNTIME_UNAVAILABLE' })
    await expect(manager.resumeSession(session.id)).rejects.toMatchObject({ code: 'RUNTIME_UNAVAILABLE' })
    expect((await manager.listRuns(session.id)).items).toEqual([])
  })

  test('does not return a public session when native creation succeeds but indexing fails', async () => {
    class DuplicateAdapter extends ManualAdapter {
      override async createSession(input: { cwd: string; options?: JsonObject }) {
        return { ...(await super.createSession(input)), nativeSessionId: 'duplicate' }
      }
    }
    await manager.dispose()
    adapter = new DuplicateAdapter()
    manager = await RuntimeManager.open({ dataDir: dir, runtimes: [adapter] })
    if ((await manager.listProjects()).items.length === 0) {
      await manager.createProject({ id: 'project', name: 'project' })
    }
    const session = await create()

    await expect(create()).rejects.toMatchObject({ code: 'STORAGE_ERROR' })
    expect(adapter.created).toHaveLength(2)
    await expect(manager.listSessions()).rejects.toMatchObject({ code: 'STORAGE_ERROR' })
    await expect(manager.dispose()).rejects.toBeInstanceOf(AggregateError)
    manager = await RuntimeManager.open({ dataDir: dir, runtimes: [new ManualAdapter()] })
    expect((await manager.listSessions()).items).toEqual([session])
    expect(await manager.resumeSession(session.id)).toEqual(session)
  })

  test('persists execution rejection without any subscribers', async () => {
    class FailingAdapter extends ManualAdapter {
      override execute(): Promise<never> {
        return Promise.reject(new RuntimeError('PROCESS_EXITED', 'Child exited'))
      }
    }
    await manager.dispose()
    adapter = new FailingAdapter()
    manager = await RuntimeManager.open({ dataDir: dir, runtimes: [adapter] })
    if ((await manager.listProjects()).items.length === 0) {
      await manager.createProject({ id: 'project', name: 'project' })
    }
    const session = await create()
    const { runId } = await manager.run(session.id, { text: 'hello' })
    await manager.dispose()
    manager = await RuntimeManager.open({ dataDir: dir, runtimes: [] })

    expect(await manager.getRun(runId)).toMatchObject({
      error: { code: 'PROCESS_EXITED', message: 'Child exited' },
      status: 'failed'
    })
    expect((await collect(manager.subscribe(runId))).at(-1)?.event).toMatchObject({
      code: 'PROCESS_EXITED',
      type: EventType.RUN_ERROR
    })
  })

  test('persists resume failure without creating a replacement native session', async () => {
    class MissingSessionAdapter extends ManualAdapter {
      override resumeSession(): Promise<never> {
        return Promise.reject(new Error('Native session missing'))
      }
    }
    await manager.dispose()
    adapter = new MissingSessionAdapter()
    manager = await RuntimeManager.open({ dataDir: dir, runtimes: [adapter] })
    if ((await manager.listProjects()).items.length === 0) {
      await manager.createProject({ id: 'project', name: 'project' })
    }
    const session = await create()
    const { runId } = await manager.run(session.id, { text: 'hello' })
    await collect(manager.subscribe(runId))

    expect(await manager.getRun(runId)).toMatchObject({
      error: { code: 'RUN_FAILED', message: 'Native session missing' },
      status: 'failed'
    })
    expect(adapter.created).toHaveLength(1)
  })

  test('disposes once and persists active completion before releasing the data directory', async () => {
    const session = await create()
    const { runId } = await manager.run(session.id, { text: 'hello' })
    await adapter.waitStarted(runId)
    const closing = manager.dispose()

    expect(manager.dispose()).toBe(closing)
    await expect(create()).rejects.toMatchObject({ code: 'DISPOSED' })
    await closing
    manager = await RuntimeManager.open({ dataDir: dir, runtimes: [] })
    expect((await manager.getRun(runId)).status).toBe('cancelled')
  })
})

describe('RuntimeManager startup validation', () => {
  test('rejects duplicate adapter kinds before acquiring data directory ownership', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'runtime-manager-validation-'))
    try {
      await expect(
        RuntimeManager.open({ dataDir: dir, runtimes: [new ManualAdapter(), new ManualAdapter()] })
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
      const lock = await acquireDirectoryLock(dir)
      await lock.release()
    } finally {
      await rm(dir, { force: true, recursive: true })
    }
  })

  test.each(['', '  '])('rejects invalid data directory %j', async (dataDir) => {
    await expect(RuntimeManager.open({ dataDir, runtimes: [] })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })
})
