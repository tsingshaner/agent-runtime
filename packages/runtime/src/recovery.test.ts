// cspell:ignore pglite
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { EventType } from '@ag-ui/core'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { ManualAdapter } from '../test/manual-adapter'
import { RuntimeManager } from './manager'
import { SessionStore } from './store'

import type { EventEnvelope } from './types'

function gate() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
async function collect(source: AsyncIterable<EventEnvelope>) {
  const events: EventEnvelope[] = []
  for await (const event of source) {
    events.push(event)
  }
  return events
}

describe('recovery and shutdown', () => {
  let dir: string
  let manager: RuntimeManager | undefined
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'runtime-recovery-'))
  })
  afterEach(async () => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    await manager?.dispose().catch(() => {})
    await rm(dir, { force: true, recursive: true })
  })
  const open = async (adapter = new ManualAdapter()) => {
    manager = await RuntimeManager.open({ dataDir: dir, runtimes: [adapter] })
    const session = await manager.createSession({ cwd: dir, projectId: 'project', runtime: adapter.kind })
    return { adapter, manager, session }
  }

  test('records one interrupted terminal on reopen and expires outstanding approvals', async () => {
    const store = await SessionStore.open(dir)
    await store.insertSession({
      cwd: dir,
      id: 's1',
      nativeSessionId: 'native',
      options: {},
      projectId: 'project',
      runtime: 'manual',
      title: 'test'
    })
    await store.beginRun('s1', 'r1')
    await store.appendEvent('r1', { name: 'saved', type: EventType.CUSTOM, value: {} })
    await store.requestApproval('r1', {
      allowedDecisions: ['approve', 'deny'],
      detail: {},
      kind: 'command',
      nativeRequestId: 1
    })
    const responding = await store.requestApproval('r1', {
      allowedDecisions: ['approve'],
      detail: {},
      kind: 'file-change',
      nativeRequestId: 2
    })
    await store.claimApproval('r1', responding.id, 'approve')
    await store.close()
    const adapter = new ManualAdapter()
    manager = await RuntimeManager.open({ dataDir: dir, runtimes: [adapter] })
    expect(await manager.getRun('r1')).toMatchObject({ error: { code: 'INTERRUPTED' }, status: 'interrupted' })
    const first = await collect(manager.subscribe('r1'))
    expect(first.filter(({ event }) => event.type === EventType.RUN_ERROR)).toHaveLength(1)
    expect(
      first.filter(({ event }) => event.type === EventType.CUSTOM && event.name === 'runtime.approval.resolved')
    ).toHaveLength(2)
    expect(first[1]?.event).toMatchObject({ name: 'saved' })
    expect(await manager.listPendingApprovals('r1')).toEqual([])
    expect(adapter.executions.size).toBe(0)
    await manager.dispose()
    manager = await RuntimeManager.open({ dataDir: dir, runtimes: [new ManualAdapter()] })
    expect(await collect(manager.subscribe('r1'))).toEqual(first)
    expect((await manager.getSession('s1')).activeRunId).toBeNull()
  })

  test('fails every subscription and admission on a rolled back event write without fabricating a terminal', async () => {
    const { adapter, manager, session } = await open()
    const { runId } = await manager.run(session.id, { text: 'hello' })
    await adapter.waitStarted(runId)
    const subscriptions = [
      manager.subscribe(runId)[Symbol.asyncIterator](),
      manager.subscribe(runId)[Symbol.asyncIterator]()
    ]
    await Promise.all(subscriptions.map((iterator) => iterator.next()))
    const pending = subscriptions.map((iterator) =>
      iterator.next().then(
        () => 'unexpected event',
        (error: unknown) => error
      )
    )
    const store = Reflect.get(manager, 'store') as SessionStore
    const failure = new Error('disk write failed')
    const original = store.db.transaction.bind(store.db)
    vi.spyOn(store.db, 'transaction').mockImplementationOnce((callback) =>
      original(async (tx) => {
        await callback(tx)
        throw failure
      })
    )
    await expect(
      adapter.push(runId, { event: { name: 'lost', type: EventType.CUSTOM, value: {} }, kind: 'event' })
    ).rejects.toMatchObject({ cause: failure, code: 'STORAGE_ERROR' })
    expect(await Promise.all(pending)).toEqual([
      expect.objectContaining({ cause: failure, code: 'STORAGE_ERROR' }),
      expect.objectContaining({ cause: failure, code: 'STORAGE_ERROR' })
    ])
    await expect(manager.run(session.id, { text: 'again' })).rejects.toMatchObject({ code: 'STORAGE_ERROR' })
    await expect(manager.respondApproval(runId, 'approval', 'approve')).rejects.toMatchObject({ code: 'STORAGE_ERROR' })
    await expect(manager.clearRunEvents(runId)).rejects.toMatchObject({ code: 'STORAGE_ERROR' })
    await expect(manager.dispose()).rejects.toBeInstanceOf(AggregateError)
    const reopened = await SessionStore.open(dir)
    try {
      expect((await reopened.getRun(runId)).endedAt).toBeNull()
      expect((await reopened.readEventPage(runId, 0)).map(({ event }) => event.type)).toEqual([EventType.RUN_STARTED])
    } finally {
      await reopened.close()
    }
  })

  test('waits for an accepted creation before disposing its adapter', async () => {
    const entered = gate()
    const release = gate()
    let disposed = false
    class Adapter extends ManualAdapter {
      override async createSession(input: Parameters<ManualAdapter['createSession']>[0]) {
        entered.resolve()
        await release.promise
        expect(disposed).toBe(false)
        return super.createSession(input)
      }
      override dispose() {
        disposed = true
        return super.dispose()
      }
    }
    manager = await RuntimeManager.open({ dataDir: dir, runtimes: [new Adapter()] })
    const creating = manager.createSession({ cwd: dir, projectId: 'project', runtime: 'manual' })
    await entered.promise
    const closing = manager.dispose()
    expect(disposed).toBe(false)
    release.resolve()
    await creating
    await closing
    expect(disposed).toBe(true)
  })

  test('collects adapter failures while still closing the database and other adapters', async () => {
    let disposed = false
    const failure = new Error('adapter cleanup failed')
    class Broken extends ManualAdapter {
      override dispose() {
        return Promise.reject(failure)
      }
    }
    const other = {
      ...new ManualAdapter(),
      cancel: async () => {},
      createSession: async () => ({ cwd: dir, nativeSessionId: 'other', options: {} }),
      dispose: () => {
        disposed = true
        return Promise.resolve()
      },
      execute: async () => ({ status: 'succeeded' as const }),
      kind: 'other',
      respondApproval: async () => {},
      resumeSession: async () => {}
    }
    manager = await RuntimeManager.open({ dataDir: dir, runtimes: [new Broken(), other] })
    await expect(manager.dispose()).rejects.toMatchObject({ errors: [failure] })
    expect(disposed).toBe(true)
    const reopened = await SessionStore.open(dir)
    await reopened.close()
  })

  test('forces stuck cancellation and disposal within bounded shutdown phases', async () => {
    const cancelling = gate()
    const disposing = gate()
    class Stuck extends ManualAdapter {
      override cancel() {
        cancelling.resolve()
        return new Promise<void>(() => {})
      }
      override dispose() {
        disposing.resolve()
        return new Promise<void>(() => {})
      }
    }
    const { manager, adapter, session } = await open(new Stuck())
    const { runId } = await manager.run(session.id, { text: 'hello' })
    await adapter.waitStarted(runId)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const result = manager.dispose().catch((error: unknown) => error)
    await cancelling.promise
    await vi.advanceTimersByTimeAsync(5000)
    await disposing.promise
    await vi.advanceTimersByTimeAsync(5000)
    expect(await result).toBeInstanceOf(AggregateError)
    vi.useRealTimers()
    const store = await SessionStore.open(dir)
    try {
      expect(await store.getRun(runId)).toMatchObject({ error: { code: 'PROCESS_EXITED' }, status: 'failed' })
    } finally {
      await store.close()
    }
  })
  test('retains ownership if an accepted database write cannot drain', async () => {
    const { manager, session } = await open()
    const store = Reflect.get(manager, 'store') as SessionStore
    const entered = gate()
    const release = gate()
    const original = store.db.transaction.bind(store.db)
    vi.spyOn(store.db, 'transaction').mockImplementationOnce((callback) =>
      original(async (tx) => {
        entered.resolve()
        await release.promise
        return callback(tx)
      })
    )
    const starting = manager.run(session.id, { text: 'hello' }).catch((error: unknown) => error)
    await entered.promise
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const closing = manager.dispose().catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(15000)
    expect(await closing).toBeInstanceOf(AggregateError)
    await expect(SessionStore.open(dir)).rejects.toMatchObject({ code: 'DATA_DIR_BUSY' })
    release.resolve()
    expect(await starting).toMatchObject({ code: 'DISPOSED' })
    vi.useRealTimers()
    await store.close()
  })

  test('never executes a run after its delayed resume outlives disposal', async () => {
    const { manager, adapter, session } = await open()
    const release = gate()
    adapter.resumeGate = release.promise
    const { runId } = await manager.run(session.id, { text: 'hello' })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const closing = manager.dispose().catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(5000)
    expect(await closing).toBeInstanceOf(AggregateError)
    release.resolve()
    await release.promise
    expect(adapter.executions.size).toBe(0)
    vi.useRealTimers()
    const store = await SessionStore.open(dir)
    try {
      expect(await store.getRun(runId)).toMatchObject({ error: { code: 'PROCESS_EXITED' }, status: 'failed' })
    } finally {
      await store.close()
    }
  })
  test('retains ownership until a delayed database close is confirmed', async () => {
    const { manager } = await open()
    const store = Reflect.get(manager, 'store') as SessionStore
    const client = Reflect.get(store, 'client') as { close(): Promise<void> }
    const entered = gate()
    const release = gate()
    const original = client.close.bind(client)
    vi.spyOn(client, 'close').mockImplementationOnce(async () => {
      entered.resolve()
      await release.promise
      await original()
    })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const closing = manager.dispose().catch((error: unknown) => error)
    await entered.promise
    try {
      await vi.advanceTimersByTimeAsync(5000)
      expect(await closing).toBeInstanceOf(AggregateError)
      await expect(SessionStore.open(dir)).rejects.toMatchObject({ code: 'DATA_DIR_BUSY' })
    } finally {
      release.resolve()
      vi.useRealTimers()
      await store.close()
    }
    const reopened = await SessionStore.open(dir)
    await reopened.close()
  })
})
