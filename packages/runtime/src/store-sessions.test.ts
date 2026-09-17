import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'

import { runs, sessions } from './schema'
import { SessionStore } from './store'

describe('SessionStore sessions', () => {
  let dir: string
  let store: SessionStore

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'runtime-sessions-'))
    store = await SessionStore.open(dir)
  })

  beforeEach(async () => {
    // Keep migrations and the database instance; reset all related rows together.
    await store.db.execute(sql`TRUNCATE TABLE approvals, events, runs, sessions`)
  })

  afterAll(async () => {
    await store.close()
    await rm(dir, { force: true, recursive: true })
  })

  test('filters sessions and omits archived sessions by default', async () => {
    await Promise.all([
      store.insertSession(session('s1', 'p1', 'codex')),
      store.insertSession(session('s2', 'p1', 'other')),
      store.insertSession(session('s3', 'p2', 'codex'))
    ])
    await store.setArchived('s3', true)

    const visible = await store.listSessions({ projectId: 'p1', runtime: 'codex' })
    const archived = await store.listSessions({ archived: true })

    expect(visible.items.map(({ id }) => id)).toEqual(['s1'])
    expect(archived.items.map(({ id }) => id)).toEqual(['s3'])
  })

  test('pages sessions with equal creation times without duplicates', async () => {
    await Promise.all([
      store.insertSession(session('s1')),
      store.insertSession(session('s2')),
      store.insertSession(session('s3'))
    ])
    await store.db.update(sessions).set({ createdAt: '2026-09-16T00:00:00.000Z' })

    const first = await store.listSessions({ limit: 2 })
    const second = await store.listSessions({ cursor: first.nextCursor ?? undefined, limit: 2 })

    expect(first.items.map(({ id }) => id)).toEqual(['s3', 's2'])
    expect(first.nextCursor).toEqual(expect.any(String))
    expect(second.items.map(({ id }) => id)).toEqual(['s1'])
    expect(second.nextCursor).toBeNull()
  })

  test('keeps archived sessions queryable and archiving is idempotent', async () => {
    await store.insertSession(session('s1'))

    await store.setArchived('s1', true)
    const firstArchive = await store.getSession('s1')
    await store.db.execute(sql`select pg_sleep(0.02)`)
    await store.setArchived('s1', true)
    const secondArchive = await store.getSession('s1')

    expect(secondArchive).toMatchObject({ archived: true, id: 's1' })
    expect(secondArchive.updatedAt).toBe(firstArchive.updatedAt)
  })

  test('rejects archiving a session with an active run', async () => {
    await store.insertSession(session('s1'))
    await store.db.insert(runs).values({ id: 'r1', sessionId: 's1', status: 'running' })

    await expect(store.setArchived('s1', true)).rejects.toMatchObject({ code: 'SESSION_BUSY' })
    await expect(store.getSession('s1')).resolves.toMatchObject({ archived: false })
  })

  test('returns the active run derived from persisted runs', async () => {
    await store.insertSession(session('s1'))
    await store.db.insert(runs).values({ id: 'r1', sessionId: 's1', status: 'waiting_approval' })

    await expect(store.getSession('s1')).resolves.toMatchObject({ activeRunId: 'r1' })
  })

  test('reports unknown session identifiers', async () => {
    await expect(store.getSession('missing')).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' })
    await expect(store.setArchived('missing', true)).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' })
  })

  test.each([-1, 0, 1.5, 201])('rejects invalid page limit %s', async (limit) => {
    await expect(store.listSessions({ limit })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })

  test('rejects malformed and non-ISO cursors', async () => {
    const nonIsoCursor = Buffer.from(JSON.stringify({ createdAt: 'yesterday', id: 's1' })).toString('base64url')

    await expect(store.listSessions({ cursor: 'not-json' })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(store.listSessions({ cursor: nonIsoCursor })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })

  test('rejects unknown filter fields', async () => {
    await expect(store.listSessions({ extra: true } as never)).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })

  test('rejects invalid session input at the store boundary', async () => {
    await expect(
      store.insertSession({ ...session('s1'), options: { invalid: undefined } } as never)
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(store.insertSession({ ...session('s1'), extra: true } as never)).rejects.toMatchObject({
      code: 'INVALID_INPUT'
    })
  })

  test('rejects cyclic session options as invalid input', async () => {
    const options: Record<string, unknown> = {}
    options.self = options

    await expect(store.insertSession({ ...session('s1'), options } as never)).rejects.toMatchObject({
      code: 'INVALID_INPUT'
    })
  })

  test('accepts shared acyclic values in session options', async () => {
    const shared = { enabled: true }
    const stored = await store.insertSession({ ...session('s1'), options: { first: shared, second: shared } })

    expect(stored.options).toEqual({ first: { enabled: true }, second: { enabled: true } })
  })

  test('returns ISO timestamps', async () => {
    const stored = await store.insertSession(session('s1'))

    expect(stored.createdAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/)
    expect(stored.updatedAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/)
  })

  test('advances updatedAt when archiving', async () => {
    const stored = await store.insertSession(session('s1'))
    await store.db.execute(sql`select pg_sleep(0.001)`)

    await store.setArchived('s1', true)
    const archived = await store.getSession('s1')

    expect(new Date(archived.updatedAt).getTime()).toBeGreaterThan(new Date(stored.updatedAt).getTime())
  })
})

const session = (id: string, projectId = 'p1', runtime = 'codex') => {
  return {
    cwd: '/workspace',
    id,
    nativeSessionId: `native-${id}`,
    options: { model: 'test-model' },
    projectId,
    runtime,
    title: id
  }
}
