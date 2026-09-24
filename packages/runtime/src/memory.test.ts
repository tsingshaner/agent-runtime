// cspell:ignore plpgsql
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { sql } from 'drizzle-orm'
import { expect, test, vi } from 'vitest'

import { ProjectMemory } from '../../memory/src/project'
import { ManualAdapter } from '../test/manual-adapter'
import { RuntimeManager } from './manager'
import { SessionStore } from './store'

test('publishes success with durable pending memory before a slow write and never retries unknown on reopen', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'runtime-memory-'))
  const adapter = new ManualAdapter()
  const gate = Promise.withResolvers<void>()
  const writes: unknown[] = []
  const memory = {
    recall: async () => ({ context: 'recalled context' }),
    write: async (input: unknown) => {
      writes.push(input)
      await gate.promise
      return { status: 'unknown' as const }
    }
  }
  let manager = await RuntimeManager.open({ dataDir: dir, memory, runtimes: [adapter] })
  try {
    await manager.createProject({ id: 'p', name: 'p' })
    const session = await manager.createSession({ cwd: dir, model: 'test', projectId: 'p', runtime: 'manual' })
    const { runId } = await manager.run(session.id, { text: 'new question' })
    await adapter.waitStarted(runId)
    expect(adapter.executions.get(runId)).toMatchObject({ context: 'recalled context', text: 'new question' })
    adapter.finish(runId, { finalReply: 'final answer', status: 'succeeded' })
    const events = await Array.fromAsync(manager.subscribe(runId))
    expect(events.filter(({ event }) => event.type === 'RUN_FINISHED')).toHaveLength(1)
    expect(await manager.getMemoryWrite(runId)).toMatchObject({
      assistant: 'final answer',
      projectId: 'p',
      sessionId: session.id,
      status: expect.stringMatching(/pending|unknown/),
      user: 'new question'
    })
    gate.resolve()
    await expect.poll(async () => (await manager.getMemoryWrite(runId))?.status).toBe('unknown')
    expect(await manager.getRun(runId)).toMatchObject({ status: 'succeeded' })
    await manager.dispose()
    manager = await RuntimeManager.open({ dataDir: dir, memory, runtimes: [new ManualAdapter()] })
    expect(await manager.getMemoryWrite(runId)).toMatchObject({ status: 'unknown' })
    expect(writes).toHaveLength(1)
    expect(await Array.fromAsync(manager.subscribe(runId))).toEqual(events)
  } finally {
    gate.resolve()
    await manager.dispose()
    await rm(dir, { force: true, recursive: true })
  }
})

test('degrades recall safely, bounds hung services and excludes failed runs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'runtime-memory-'))
  const adapter = new ManualAdapter()
  let calls = 0
  const manager = await RuntimeManager.open({
    dataDir: dir,
    memory: {
      recall: () => new Promise(() => {}),
      write: () => {
        calls++
        return new Promise(() => {})
      }
    },
    memoryTimeoutMs: 30,
    runtimes: [adapter]
  })
  try {
    await manager.createProject({ id: 'p', name: 'p' })
    const session = await manager.createSession({ cwd: dir, model: 'test', projectId: 'p', runtime: 'manual' })
    const { runId } = await manager.run(session.id, { text: 'new' })
    await adapter.waitStarted(runId)
    expect(adapter.executions.get(runId)).not.toHaveProperty('context')
    expect(await manager.getRun(runId)).toMatchObject({ memoryError: { code: 'MEMORY_RECALL_FAILED' } })
    adapter.finish(runId, { finalReply: 'answer', status: 'succeeded' })
    await Array.fromAsync(manager.subscribe(runId))
    await expect.poll(() => calls).toBe(1)
    await expect.poll(async () => (await manager.getMemoryWrite(runId))?.status).toBe('unknown')
    const next = await manager.run(session.id, { text: 'failed question' })
    await adapter.waitStarted(next.runId)
    adapter.finish(next.runId, { finalReply: 'partial', status: 'failed' })
    await Array.fromAsync(manager.subscribe(next.runId))
    expect(await manager.getMemoryWrite(next.runId)).toBeNull()
    expect(calls).toBe(1)
  } finally {
    await manager.dispose()
    await rm(dir, { force: true, recursive: true })
  }
})

test('rolls back success when the memory record cannot commit and preserves committed pending records on reopen', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'runtime-memory-'))
  const store = await SessionStore.open(dir)
  try {
    await store.insertSession({
      cwd: dir,
      id: 's',
      nativeSessionId: 'n',
      options: {},
      projectId: 'p',
      runtime: 'manual',
      title: 'test'
    })
    await store.beginRun('s', 'r', { text: 'question' })
    const record = {
      assistant: 'answer',
      error: null,
      projectId: 'p',
      runId: 'r',
      sessionId: 's',
      status: 'pending' as const,
      user: 'question'
    }
    await store.db.execute(
      sql`CREATE FUNCTION reject_memory() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'test fault'; END; $$ LANGUAGE plpgsql`
    )
    await store.db.execute(
      sql`CREATE TRIGGER reject_memory BEFORE INSERT ON memory_writes FOR EACH ROW EXECUTE FUNCTION reject_memory()`
    )
    await expect(store.finishRun('r', { status: 'succeeded' }, record)).rejects.toThrow()
    expect((await store.getRun('r')).status).toBe('starting')
    expect(await store.getMemoryWrite('r')).toBeNull()
    await store.db.execute(sql`DROP TRIGGER reject_memory ON memory_writes`)
    await store.finishRun('r', { status: 'succeeded' }, record)
    await store.close()
    let calls = 0
    const manager = await RuntimeManager.open({
      dataDir: dir,
      memory: {
        recall: () => Promise.resolve({ context: '' }),
        write: () => {
          calls++
          return Promise.resolve({ status: 'accepted' })
        }
      },
      runtimes: [new ManualAdapter()]
    })
    try {
      expect(await manager.getMemoryWrite('r')).toEqual(record)
      expect(
        (await Array.fromAsync(manager.subscribe('r'))).filter(({ event }) => event.type === 'RUN_FINISHED')
      ).toHaveLength(1)
      expect(calls).toBe(0)
    } finally {
      await manager.dispose()
    }
  } finally {
    await store.close()
    await rm(dir, { force: true, recursive: true })
  }
})

test('uses the official SDK through controlled HTTP without exposing service errors or altering success', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'runtime-memory-'))
  const bodies: Record<string, unknown>[] = []
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = []
      for await (const chunk of request) {
        chunks.push(chunk)
      }
      if (request.url?.endsWith('/add')) {
        bodies.push(JSON.parse(Buffer.concat(chunks).toString()))
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({ code: 0, data: { accepted_ids: ['u', 'a'] } }))
      } else {
        response.writeHead(503)
        response.end('private upstream failure')
      }
    })().catch(() => response.destroy())
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('No server')
  }
  process.env.RUNTIME_MEMORY_TEST_TOKEN = 'test-token'
  const adapter = new ManualAdapter()
  const manager = await RuntimeManager.open({
    dataDir: dir,
    memory: new ProjectMemory({
      apiKeyEnv: 'RUNTIME_MEMORY_TEST_TOKEN',
      endpoint: `http://127.0.0.1:${address.port}`,
      serviceId: 'test'
    }),
    runtimes: [adapter]
  })
  try {
    await manager.createProject({ id: 'p', name: 'p' })
    const session = await manager.createSession({ cwd: dir, model: 'test', projectId: 'p', runtime: 'manual' })
    const { runId } = await manager.run(session.id, { text: 'new user input' })
    await adapter.waitStarted(runId)
    adapter.finish(runId, { finalReply: 'final reply', status: 'succeeded' })
    await Array.fromAsync(manager.subscribe(runId))
    await expect.poll(async () => (await manager.getMemoryWrite(runId))?.status).toBe('accepted')
    expect(await manager.getRun(runId)).toMatchObject({
      memoryError: { code: 'MEMORY_RECALL_FAILED' },
      status: 'succeeded'
    })
    expect(JSON.stringify(await manager.getRun(runId))).not.toContain('private upstream')
    expect(bodies).toHaveLength(1)
    expect(bodies[0]).toMatchObject({
      messages: [{ content: 'new user input' }, { content: 'final reply' }],
      session_id: session.id,
      team_id: 'p'
    })
  } finally {
    await manager.dispose()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    delete process.env.RUNTIME_MEMORY_TEST_TOKEN
    await rm(dir, { force: true, recursive: true })
  }
})

test('bounds shutdown waiting on memory persistence and prevents late network dispatch', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'runtime-memory-'))
  const adapter = new ManualAdapter()
  let calls = 0
  const store = await SessionStore.open(dir)
  const opening = vi.spyOn(SessionStore, 'open').mockResolvedValueOnce(store)
  const manager = await RuntimeManager.open({
    dataDir: dir,
    memory: {
      recall: () => Promise.resolve({ context: '' }),
      write: () => {
        calls++
        return Promise.resolve({ status: 'accepted' })
      }
    },
    runtimes: [adapter]
  })
  opening.mockRestore()
  const entered = Promise.withResolvers<void>()
  const gate = Promise.withResolvers<void>()
  vi.spyOn(store, 'finishMemoryWrite').mockImplementationOnce(() => {
    entered.resolve()
    return gate.promise
  })
  try {
    await manager.createProject({ id: 'p', name: 'p' })
    const session = await manager.createSession({ cwd: dir, model: 'test', projectId: 'p', runtime: 'manual' })
    const { runId } = await manager.run(session.id, { text: 'new' })
    await adapter.waitStarted(runId)
    adapter.finish(runId, { finalReply: 'reply', status: 'succeeded' })
    await entered.promise
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const closing = manager.dispose().catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(5000)
    gate.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(await closing).toBeInstanceOf(AggregateError)
    expect(calls).toBe(0)
  } finally {
    gate.resolve()
    vi.useRealTimers()
    await manager.dispose().catch(() => {})
    await rm(dir, { force: true, recursive: true })
  }
})
