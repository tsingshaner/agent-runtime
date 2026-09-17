import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test } from 'vitest'

import { ManualAdapter } from '../test/manual-adapter'
import { RuntimeManager } from './manager'
import { SessionStore } from './store'

test('deduplicates concurrent requests and finds completed runs after restart without an adapter', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'runtime-request-'))
  const adapter = new ManualAdapter()
  let manager = await RuntimeManager.open({ dataDir: dir, runtimes: [adapter] })
  try {
    const project = await manager.createProject({ name: 'Requests' })
    const session = await manager.createSession({ cwd: dir, model: 'test', projectId: project.id, runtime: 'manual' })
    const input = { requestId: 'request-1', text: 'hello' }
    const submitted = await Promise.all(Array.from({ length: 8 }, () => manager.run(session.id, input)))
    const first = submitted[0]
    if (!first) {
      throw new Error('Missing run')
    }
    expect(submitted.every(({ runId }) => runId === first.runId)).toBe(true)
    await adapter.waitStarted(first.runId)
    expect(adapter.executions.size).toBe(1)
    await expect(manager.run(session.id, { ...input, text: 'different' })).rejects.toMatchObject({
      code: 'REQUEST_CONFLICT'
    })
    adapter.finish(first.runId, { status: 'succeeded' })
    await Array.fromAsync(manager.subscribe(first.runId))
    await manager.archiveSession(session.id)
    await manager.dispose()
    manager = await RuntimeManager.open({ dataDir: dir, runtimes: [] })
    expect(await manager.run(session.id, input)).toEqual(first)
    expect((await manager.listRuns(session.id)).items).toHaveLength(1)
  } finally {
    await manager.dispose()
    await rm(dir, { force: true, recursive: true })
  }
})

test('scopes IDs to sessions and leaves requests without IDs independent', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'runtime-request-'))
  const adapter = new ManualAdapter()
  const manager = await RuntimeManager.open({ dataDir: dir, runtimes: [adapter] })
  try {
    const project = await manager.createProject({ name: 'Requests' })
    const sessions = await Promise.all(
      [1, 2].map(() => manager.createSession({ cwd: dir, model: 'test', projectId: project.id, runtime: 'manual' }))
    )
    const submitted = await Promise.all(
      sessions.map(({ id }) => manager.run(id, { requestId: 'shared', text: 'hello' }))
    )
    expect(new Set(submitted.map(({ runId }) => runId)).size).toBe(2)
    for (const { runId } of submitted) {
      await adapter.waitStarted(runId)
      adapter.finish(runId, { status: 'succeeded' })
      await Array.fromAsync(manager.subscribe(runId))
    }
    const session = sessions[0]
    if (!session) {
      throw new Error('Missing session')
    }
    const repeated: string[] = []
    for (let index = 0; index < 2; index++) {
      const { runId } = await manager.run(session.id, { text: 'hello' })
      repeated.push(runId)
      await adapter.waitStarted(runId)
      adapter.finish(runId, { status: 'succeeded' })
      await Array.fromAsync(manager.subscribe(runId))
    }
    expect(new Set(repeated).size).toBe(2)
    await expect(manager.run(session.id, { requestId: ' ', text: 'hello' })).rejects.toMatchObject({
      code: 'INVALID_INPUT'
    })
    adapter.resumeSession = () => Promise.reject(new Error('Native session unavailable'))
    const failed = await manager.run(session.id, { requestId: 'failure', text: 'fail before execution' })
    await Array.fromAsync(manager.subscribe(failed.runId))
    expect((await manager.getRun(failed.runId)).status).toBe('failed')
    expect(await manager.run(session.id, { requestId: 'failure', text: 'fail before execution' })).toEqual(failed)
  } finally {
    await manager.dispose()
    await rm(dir, { force: true, recursive: true })
  }
})

test('returns interrupted requests after recovery without replaying native work', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'runtime-request-'))
  const store = await SessionStore.open(dir)
  await store.insertSession({
    cwd: dir,
    id: 'session',
    nativeSessionId: 'native',
    options: {},
    projectId: 'project',
    runtime: 'manual',
    title: 'Legacy'
  })
  await store.beginRun('session', 'original-run', { requestId: 'lost-response', text: 'hello' })
  await store.close()
  const adapter = new ManualAdapter()
  const manager = await RuntimeManager.open({ dataDir: dir, runtimes: [adapter] })
  try {
    expect(await manager.run('session', { requestId: 'lost-response', text: 'hello' })).toEqual({
      runId: 'original-run',
      sessionId: 'session'
    })
    expect((await manager.getRun('original-run')).status).toBe('interrupted')
    expect(adapter.resumed).toHaveLength(0)
    expect(adapter.executions.size).toBe(0)
  } finally {
    await manager.dispose()
    await rm(dir, { force: true, recursive: true })
  }
})
