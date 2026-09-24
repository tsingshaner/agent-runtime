import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { EventType } from '@ag-ui/core'
import { sql } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest'

import { setupMemoryDatabase } from '../test/memory-database.fixture'
import { RuntimeError } from './errors'
import { SessionStore } from './store'
import { subscribeToRun } from './subscription'

import type { EventEnvelope } from './types'

setupMemoryDatabase()

describe('run subscriptions', () => {
  let dir: string
  let store: SessionStore

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'runtime-subscription-'))
    store = await SessionStore.open(dir)
  })

  beforeEach(async () => {
    // Keep migrations and the database instance; reset all related rows together.
    await store.db.execute(
      sql`TRUNCATE TABLE memory_writes, input_requests, approvals, approval_batches, events, runs, sessions`
    )
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

  test('replays events produced without a subscriber', async () => {
    await store.beginRun('s1', 'r1')
    const first = store.subscribe('r1')[Symbol.asyncIterator]()
    expect((await first.next()).value?.sequence).toBe(1)
    await first.return?.()
    await store.appendEvent('r1', { name: 'test.progress', type: EventType.CUSTOM, value: 1 })
    await store.finishRun('r1', { status: 'succeeded' })
    const replay: EventEnvelope[] = []
    for await (const event of store.subscribe('r1', { afterSequence: 1 })) {
      replay.push(event)
    }
    expect(replay.map((event) => event.sequence)).toEqual([2, 3])
    expect(replay[1]?.event.type).toBe(EventType.RUN_FINISHED)
  })

  test('drains all committed pages before ending a terminal replay', async () => {
    await store.beginRun('s1', 'r1')
    for (let value = 0; value < 130; value++) {
      await store.appendEvent('r1', { name: 'progress', type: EventType.CUSTOM, value })
    }
    await store.finishRun('r1', { status: 'succeeded' })

    const replay = await collect(store.subscribe('r1'))

    expect(replay).toHaveLength(132)
    expect(replay.at(-1)).toMatchObject({ event: { type: EventType.RUN_FINISHED }, sequence: 132 })
  })

  test.each([-1, 0.5, 2, NaN, Infinity, null as never])(
    'rejects initial cursor %s outside integer committed range',
    async (afterSequence) => {
      await store.beginRun('s1', 'r1')

      await expect(store.subscribe('r1', { afterSequence })[Symbol.asyncIterator]().next()).rejects.toMatchObject({
        code: 'INVALID_INPUT'
      })
    }
  )

  test('gives cleared history precedence over invalid cursors', async () => {
    await store.beginRun('s1', 'r1')
    await store.finishRun('r1', { status: 'succeeded' })
    await store.clearRunEvents('r1')

    await expect(store.subscribe('r1', { afterSequence: 999 })[Symbol.asyncIterator]().next()).rejects.toMatchObject({
      code: 'EVENTS_CLEARED'
    })
  })

  test('keeps slow and fast subscribers independent', async () => {
    await store.beginRun('s1', 'r1')
    const slow = store.subscribe('r1')[Symbol.asyncIterator]()
    expect((await slow.next()).value?.sequence).toBe(1)
    await store.appendEvent('r1', { name: 'progress', type: EventType.CUSTOM })
    await store.finishRun('r1', { status: 'succeeded' })

    const fast = await collect(store.subscribe('r1'))
    const rest = [await slow.next(), await slow.next(), await slow.next()]

    expect(fast.map((event) => event.sequence)).toEqual([1, 2, 3])
    expect(rest.map((result) => result.value?.sequence)).toEqual([2, 3, undefined])
    expect(rest[2]?.done).toBe(true)
  })

  test('rejects clearing while an iterator holds a replay page', async () => {
    await store.beginRun('s1', 'r1')
    await store.finishRun('r1', { status: 'succeeded' })
    const iterator = store.subscribe('r1')[Symbol.asyncIterator]()
    await iterator.next()

    await store.clearRunEvents('r1')

    await expect(iterator.next()).rejects.toMatchObject({ code: 'EVENTS_CLEARED' })
  })

  test('does not lose an append between the empty read and waiting', async () => {
    await store.beginRun('s1', 'r1')
    const entered = barrier()
    const release = barrier()
    let emptyRead = false
    const source = {
      assertAvailable: store.assertAvailable.bind(store),
      getRun: async (runId: string) => {
        const run = await store.getRun(runId)
        if (emptyRead) {
          emptyRead = false
          entered.resolve()
          await release.promise
        }
        return run
      },
      onRunChange: store.onRunChange.bind(store),
      readEventPage: async (runId: string, sequence: number) => {
        const page = await store.readEventPage(runId, sequence)
        emptyRead = page.length === 0
        return page
      }
    }
    const iterator = subscribeToRun(source, 'r1', { afterSequence: 1 })[Symbol.asyncIterator]()
    const pending = iterator.next()
    await entered.promise
    await store.appendEvent('r1', { name: 'raced', type: EventType.CUSTOM })
    release.resolve()

    expect((await pending).value).toMatchObject({ event: { name: 'raced' }, sequence: 2 })
    await iterator.return?.()
  })

  test('replays a terminal event committed after an empty page read', async () => {
    await store.beginRun('s1', 'r1')
    const entered = barrier()
    const release = barrier()
    const source = {
      assertAvailable: store.assertAvailable.bind(store),
      getRun: store.getRun.bind(store),
      onRunChange: store.onRunChange.bind(store),
      readEventPage: async (runId: string, sequence: number) => {
        const page = await store.readEventPage(runId, sequence)
        if (page.length === 0) {
          entered.resolve()
          await release.promise
        }
        return page
      }
    }
    const iterator = subscribeToRun(source, 'r1', { afterSequence: 1 })[Symbol.asyncIterator]()
    const pending = iterator.next()
    await entered.promise
    await store.finishRun('r1', { status: 'succeeded' })
    release.resolve()

    expect((await pending).value).toMatchObject({ event: { type: EventType.RUN_FINISHED }, sequence: 2 })
    expect((await iterator.next()).done).toBe(true)
  })

  test.each(['abort', 'return'] as const)(
    'interrupts a waiting next with %s and removes its listener',
    async (action) => {
      await store.beginRun('s1', 'r1')
      const waiting = barrier()
      const controller = new AbortController()
      let emptyRead = false
      let listenerCount = 0
      const source = {
        assertAvailable: store.assertAvailable.bind(store),
        getRun: async (runId: string) => {
          const run = await store.getRun(runId)
          // The next event-loop turn starts after the iterator installs its wait.
          if (emptyRead) {
            setImmediate(waiting.resolve)
          }
          return run
        },
        onRunChange: (runId: string, listener: () => void) => {
          listenerCount++
          const unsubscribe = store.onRunChange(runId, listener)
          return () => {
            listenerCount--
            unsubscribe()
          }
        },
        readEventPage: async (runId: string, sequence: number) => {
          const page = await store.readEventPage(runId, sequence)
          emptyRead = page.length === 0
          return page
        }
      }
      const iterator = subscribeToRun(source, 'r1', { afterSequence: 1, signal: controller.signal })[
        Symbol.asyncIterator
      ]()
      const pending = iterator.next()
      await waiting.promise
      if (action === 'abort') {
        controller.abort()
      } else {
        await iterator.return?.()
      }

      expect(await pending).toEqual({ done: true, value: undefined })
      expect(listenerCount).toBe(0)
      expect((await store.getRun('r1')).status).toBe('starting')
    }
  )

  test('reports a clear queued before a replay read instead of an empty page', async () => {
    await store.beginRun('s1', 'r1')
    await store.finishRun('r1', { status: 'succeeded' })
    const entered = barrier()
    const release = barrier()
    const holding = store.db.transaction(async () => {
      entered.resolve()
      await release.promise
    })
    await entered.promise
    const clearing = store.clearRunEvents('r1')
    const reading = store.readEventPage('r1', 0)
    const assertion = expect(reading).rejects.toMatchObject({ code: 'EVENTS_CLEARED' })
    release.resolve()

    await Promise.all([holding, clearing, assertion])
  })

  test('ends immediately for an already aborted signal', async () => {
    const iterator = store.subscribe('missing', { signal: AbortSignal.abort() })[Symbol.asyncIterator]()

    expect(await iterator.next()).toEqual({ done: true, value: undefined })
  })
})

describe('run subscription lifecycle', () => {
  let dir: string
  let store: SessionStore

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'runtime-subscription-'))
    store = await SessionStore.open(dir)
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

  afterEach(async () => {
    await store.close()
    await rm(dir, { force: true, recursive: true })
  })

  test.each(['storage failure', 'disposal'] as const)(
    'rejects terminal completion when %s occurs during the final status read',
    async (action) => {
      await store.beginRun('s1', 'r1')
      await store.finishRun('r1', { status: 'succeeded' })
      const entered = barrier()
      const release = barrier()
      let emptyRead = false
      const source = {
        assertAvailable: store.assertAvailable.bind(store),
        getRun: async (runId: string) => {
          const run = await store.getRun(runId)
          if (emptyRead) {
            entered.resolve()
            await release.promise
          }
          return run
        },
        onRunChange: store.onRunChange.bind(store),
        readEventPage: async (runId: string, sequence: number) => {
          const page = await store.readEventPage(runId, sequence)
          emptyRead = page.length === 0
          return page
        }
      }
      const iterator = subscribeToRun(source, 'r1', { afterSequence: 2 })[Symbol.asyncIterator]()
      const pending = iterator.next()
      await entered.promise
      const failure = new RuntimeError('STORAGE_ERROR', 'Write failed', { cause: new Error('Disk unavailable') })
      try {
        if (action === 'storage failure') {
          store.fail(failure)
        } else {
          await store.close()
        }
        release.resolve()
        if (action === 'storage failure') {
          await expect(pending).rejects.toBe(failure)
        } else {
          await expect(pending).rejects.toMatchObject({ code: 'DISPOSED' })
        }
      } finally {
        release.resolve()
        await iterator.return?.()
      }
    }
  )

  test('reports disposal when closed while paused inside a replay page', async () => {
    await store.beginRun('s1', 'r1')
    await store.finishRun('r1', { status: 'succeeded' })
    const iterator = store.subscribe('r1')[Symbol.asyncIterator]()
    expect((await iterator.next()).value?.sequence).toBe(1)
    await store.close()
    await expect(iterator.next()).rejects.toMatchObject({ code: 'DISPOSED' })
  })
})

const collect = async (source: AsyncIterable<EventEnvelope>): Promise<EventEnvelope[]> => {
  const result: EventEnvelope[] = []
  for await (const event of source) {
    result.push(event)
  }
  return result
}

const barrier = () => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
