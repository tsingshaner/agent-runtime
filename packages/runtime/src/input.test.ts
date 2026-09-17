import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, expect, test } from 'vitest'

import { ManualAdapter } from '../test/manual-adapter'
import { RuntimeManager } from './manager'
import { SessionStore } from './store'

let dir: string
let manager: RuntimeManager
let adapter: ManualAdapter
let sessionId: string
let runId: string
const questions = [{ header: 'Choice', id: 'choice', question: 'Which value?' }]
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'runtime-input-'))
  adapter = new ManualAdapter()
  manager = await RuntimeManager.open({ dataDir: dir, runtimes: [adapter] })
  const project = await manager.createProject({ name: 'Input' })
  sessionId = (await manager.createSession({ cwd: dir, model: 'test', projectId: project.id, runtime: 'manual' })).id
  runId = (await manager.run(sessionId, { text: 'Ask me' })).runId
  await adapter.waitStarted(runId)
})
afterEach(async () => {
  await manager.dispose()
  await rm(dir, { force: true, recursive: true })
})

test('persists input before notification and continues the same run after one claimed answer', async () => {
  await adapter.push(runId, { kind: 'input', request: { nativeRequestId: 1, questions } })
  const [request] = await manager.listPendingInputs(runId)
  expect(request).toMatchObject({ questions, status: 'pending' })
  if (!request) {
    throw new Error('Missing input')
  }
  expect((await manager.getRun(runId)).status).toBe('waiting_input')
  await expect(manager.run(sessionId, { text: 'Another' })).rejects.toMatchObject({ code: 'SESSION_BUSY' })
  const iterator = manager.subscribe(runId)[Symbol.asyncIterator]()
  await iterator.next()
  expect((await iterator.next()).value.event).toMatchObject({
    name: 'runtime.input.requested',
    value: { id: request.id }
  })
  await iterator.return?.()
  await expect(manager.respondInput(runId, request.id, { wrong: ['value'] })).rejects.toMatchObject({
    code: 'INVALID_INPUT'
  })
  const responses = await Promise.allSettled(
    [1, 2].map(() => manager.respondInput(runId, request.id, { choice: ['value'] }))
  )
  expect(responses.filter(({ status }) => status === 'fulfilled')).toHaveLength(1)
  expect(adapter.answers).toHaveLength(1)
  expect((await manager.getRun(runId)).status).toBe('running')
  expect(await manager.listPendingInputs(runId)).toEqual([])
  adapter.finish(runId, { status: 'succeeded' })
  const events = await Array.fromAsync(manager.subscribe(runId))
  expect(events.map(({ event }) => event.type)).toEqual(['RUN_STARTED', 'CUSTOM', 'CUSTOM', 'RUN_FINISHED'])
})

test('rejects cross-run answers and never repeats an uncertain response', async () => {
  await adapter.push(runId, { kind: 'input', request: { nativeRequestId: '1', questions } })
  const [request] = await manager.listPendingInputs(runId)
  if (!request) {
    throw new Error('Missing input')
  }
  const project = await manager.createProject({ name: 'Other' })
  const other = await manager.createSession({ cwd: dir, model: 'test', projectId: project.id, runtime: 'manual' })
  const second = await manager.run(other.id, { text: 'Other' })
  await adapter.waitStarted(second.runId)
  await expect(manager.respondInput(second.runId, request.id, { choice: ['value'] })).rejects.toMatchObject({
    code: 'INPUT_NOT_FOUND'
  })
  adapter.inputError = new Error('Connection lost after send')
  await expect(manager.respondInput(runId, request.id, { choice: ['value'] })).rejects.toMatchObject({
    code: 'INPUT_RESPONSE_UNCERTAIN'
  })
  await expect(manager.respondInput(runId, request.id, { choice: ['value'] })).rejects.toMatchObject({
    code: 'INPUT_NOT_PENDING'
  })
  expect(adapter.answers).toHaveLength(1)
  expect((await manager.listPendingInputs(runId))[0]?.status).toBe('responding')
  await manager.cancel(runId)
  await Array.fromAsync(manager.subscribe(runId))
  expect(await manager.listPendingInputs(runId)).toEqual([])
  await expect(manager.respondInput(runId, request.id, { choice: ['late'] })).rejects.toMatchObject({
    code: 'INPUT_NOT_PENDING'
  })
})

test('keeps waiting for remaining inputs or approvals after one answer', async () => {
  await adapter.push(runId, {
    kind: 'approval',
    request: { allowedDecisions: ['deny'], detail: {}, kind: 'command', nativeRequestId: 1 }
  })
  await adapter.push(runId, { kind: 'input', request: { nativeRequestId: 2, questions } })
  await adapter.push(runId, { kind: 'input', request: { nativeRequestId: 3, questions } })
  const requests = await manager.listPendingInputs(runId)
  for (const [index, request] of requests.entries()) {
    await manager.respondInput(runId, request.id, { choice: ['value'] })
    expect((await manager.getRun(runId)).status).toBe(index === 0 ? 'waiting_input' : 'waiting_approval')
  }
  const [approval] = await manager.listPendingApprovals(runId)
  if (!approval) {
    throw new Error('Missing approval')
  }
  await manager.respondApproval(runId, approval.id, 'deny')
  expect((await manager.getRun(runId)).status).toBe('running')
})

test('expires pending and uncertain inputs on recovery without sending answers', async () => {
  await manager.cancel(runId)
  await Array.fromAsync(manager.subscribe(runId))
  await manager.dispose()
  const store = await SessionStore.open(dir)
  await store.beginRun(sessionId, 'interrupted-run')
  await store.requestInput('interrupted-run', { nativeRequestId: 1, questions })
  await store.requestInput('interrupted-run', { nativeRequestId: 2, questions })
  const [request] = await store.listPendingInputs('interrupted-run')
  if (!request) {
    throw new Error('Missing input')
  }
  await store.claimInput('interrupted-run', request.id, { choice: ['uncertain'] })
  await store.close()
  adapter = new ManualAdapter()
  manager = await RuntimeManager.open({ dataDir: dir, runtimes: [adapter] })
  expect((await manager.getRun('interrupted-run')).status).toBe('interrupted')
  expect(await manager.listPendingInputs('interrupted-run')).toEqual([])
  await expect(manager.respondInput('interrupted-run', request.id, { choice: ['late'] })).rejects.toMatchObject({
    code: 'INPUT_NOT_PENDING'
  })
  expect(adapter.answers).toHaveLength(0)
  const events = await Array.fromAsync(manager.subscribe('interrupted-run'))
  expect(events.filter(({ event }) => event.type === 'CUSTOM' && event.name === 'runtime.input.resolved')).toHaveLength(
    2
  )
})
