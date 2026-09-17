import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { EventType } from '@ag-ui/core'
import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'

import { approvals, events, runs } from './schema'
import { SessionStore } from './store'

describe('SessionStore runs', () => {
  let dir: string
  let store: SessionStore

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'runtime-runs-'))
    store = await SessionStore.open(dir)
  })

  beforeEach(async () => {
    // Keep migrations and the database instance; reset all related rows together.
    await store.db.execute(sql`TRUNCATE TABLE input_requests, approvals, events, runs, sessions`)
    await store.insertSession({
      cwd: '/workspace',
      id: 's1',
      nativeSessionId: 'n1',
      options: {},
      projectId: 'p1',
      runtime: 'codex',
      title: 'test'
    })
  })

  afterAll(async () => {
    await store.close()
    await rm(dir, { force: true, recursive: true })
  })

  test('starts a run with its first persisted lifecycle event', async () => {
    const run = await store.beginRun('s1', 'r1')

    expect(run).toMatchObject({
      endedAt: null,
      error: null,
      eventsCleared: false,
      id: 'r1',
      lastSequence: 1,
      nativeTurnId: null,
      sessionId: 's1',
      status: 'starting'
    })
    expect(await store.readEventPage('r1', 0)).toEqual([
      { event: { runId: 'r1', threadId: 's1', type: EventType.RUN_STARTED }, runId: 'r1', sequence: 1, sessionId: 's1' }
    ])
  })

  test('allows only one concurrent run for a session', async () => {
    const results = await Promise.allSettled([store.beginRun('s1', 'r1'), store.beginRun('s1', 'r2')])

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({ reason: { code: 'SESSION_BUSY' } })
  })

  test('rejects runs on archived or missing sessions', async () => {
    await store.setArchived('s1', true)

    await expect(store.beginRun('s1', 'r1')).rejects.toMatchObject({ code: 'SESSION_ARCHIVED' })
    await expect(store.beginRun('missing', 'r2')).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' })
  })

  test('persists the native turn without reviving terminal runs', async () => {
    await store.beginRun('s1', 'r1')
    await store.setNativeTurn('r1', 'native-turn')
    expect(await store.getRun('r1')).toMatchObject({ nativeTurnId: 'native-turn', status: 'running' })
    await store.finishRun('r1', { status: 'succeeded' })
    await store.setNativeTurn('r1', 'late-turn')
    expect(await store.getRun('r1')).toMatchObject({ nativeTurnId: 'native-turn', status: 'succeeded' })
  })

  test('allocates consecutive sequences for concurrent appends after commit', async () => {
    await store.beginRun('s1', 'r1')
    const observed: Promise<unknown>[] = []
    const unlisten = store.onRunChange('r1', () => {
      observed.push(store.readEventPage('r1', 0))
    })
    const appended = await Promise.all(
      Array.from({ length: 8 }, (_, value) =>
        store.appendEvent('r1', { name: 'progress', type: EventType.CUSTOM, value })
      )
    )
    unlisten()

    expect(appended.map((event) => event.sequence).sort((a, b) => a - b)).toEqual([2, 3, 4, 5, 6, 7, 8, 9])
    expect(await store.readEventPage('r1', 0, 3)).toHaveLength(3)
    expect(await Promise.all(observed)).toHaveLength(8)
  })

  test('rolls sequence allocation back when event insertion fails', async () => {
    await store.beginRun('s1', 'r1')
    await store.db
      .insert(events)
      .values({ event: { name: 'collision', type: EventType.CUSTOM }, runId: 'r1', sequence: 2 })

    await expect(store.appendEvent('r1', { name: 'progress', type: EventType.CUSTOM })).rejects.toThrow()
    expect((await store.getRun('r1')).lastSequence).toBe(1)
  })

  test('expires outstanding approvals before a single terminal event', async () => {
    await store.beginRun('s1', 'r1')
    await store.db.insert(approvals).values(
      ['pending', 'responding'].map((status, index) => ({
        allowedDecisions: ['approve' as const, 'deny' as const],
        decision: index ? ('approve' as const) : null,
        detail: {},
        id: `a${index}`,
        kind: 'command' as const,
        nativeRequestId: index,
        runId: 'r1',
        status: status as 'pending' | 'responding'
      }))
    )

    await Promise.all([store.finishRun('r1', { status: 'cancelled' }), store.finishRun('r1', { status: 'succeeded' })])
    const page = await store.readEventPage('r1', 1)

    expect(page.map((item) => item.sequence)).toEqual([2, 3, 4])
    expect(page.slice(0, 2).map((item) => item.event)).toEqual([
      {
        name: 'runtime.approval.resolved',
        type: EventType.CUSTOM,
        value: { approvalId: 'a0', decision: null, status: 'expired' }
      },
      {
        name: 'runtime.approval.resolved',
        type: EventType.CUSTOM,
        value: { approvalId: 'a1', decision: 'approve', status: 'expired' }
      }
    ])
    expect(page[2]?.event.type).toBe(EventType.RUN_ERROR)
    expect((await store.db.select().from(approvals)).map((item) => item.status)).toEqual(['expired', 'expired'])
    expect(await store.getRun('r1')).toMatchObject({ endedAt: expect.any(String), status: 'cancelled' })
    await expect(store.appendEvent('r1', { name: 'late', type: EventType.CUSTOM })).rejects.toMatchObject({
      code: 'RUN_TERMINAL'
    })
    expect((await store.beginRun('s1', 'r2')).status).toBe('starting')
  })

  test('rejects lifecycle events through the business event path', async () => {
    await store.beginRun('s1', 'r1')

    await expect(
      store.appendEvent('r1', { runId: 'r1', threadId: 's1', type: EventType.RUN_FINISHED })
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect((await store.getRun('r1')).lastSequence).toBe(1)
  })

  test('clears only terminal event history and retains its highest sequence', async () => {
    await store.beginRun('s1', 'r1')
    await expect(store.clearRunEvents('r1')).rejects.toMatchObject({ code: 'RUN_ACTIVE' })
    await store.finishRun('r1', { status: 'succeeded' })

    await store.clearRunEvents('r1')
    await store.clearRunEvents('r1')

    expect(await store.getRun('r1')).toMatchObject({ eventsCleared: true, lastSequence: 2, status: 'succeeded' })
    expect(await store.db.select().from(events)).toEqual([])
    await expect(store.readEventPage('r1', 0)).rejects.toMatchObject({ code: 'EVENTS_CLEARED' })
  })

  test('pages runs with tied creation timestamps', async () => {
    for (const id of ['r1', 'r2', 'r3']) {
      await store.beginRun('s1', id)
      await store.finishRun(id, { status: 'succeeded' })
    }
    await store.db.update(runs).set({ createdAt: '2026-09-16T00:00:00.000Z' }).where(eq(runs.sessionId, 's1'))

    const first = await store.listRuns('s1', { limit: 2 })
    const second = await store.listRuns('s1', { cursor: first.nextCursor ?? undefined, limit: 2 })

    expect(first.items.map((run) => run.id)).toEqual(['r3', 'r2'])
    expect(second.items.map((run) => run.id)).toEqual(['r1'])
    expect(second.nextCursor).toBeNull()
    await expect(store.listRuns('s1', { limit: 0 })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(store.listRuns('missing')).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' })
    await expect(store.getRun('missing')).rejects.toMatchObject({ code: 'RUN_NOT_FOUND' })
  })
})
