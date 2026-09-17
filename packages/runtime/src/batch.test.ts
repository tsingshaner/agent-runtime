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
let runId: string
const batch = {
  nativeRequestId: 'batch',
  requests: [
    {
      allowedDecisions: ['approve', 'deny'] as const,
      detail: { name: 'write' },
      kind: 'tool' as const,
      nativeRequestId: 'a'
    },
    {
      allowedDecisions: ['approve', 'deny'] as const,
      detail: { name: 'delete' },
      kind: 'tool' as const,
      nativeRequestId: 'b'
    }
  ]
}
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'runtime-batch-'))
  adapter = new ManualAdapter()
  manager = await RuntimeManager.open({ dataDir: dir, runtimes: [adapter] })
  const project = await manager.createProject({ name: 'Batch' })
  const session = await manager.createSession({ cwd: dir, model: 'test', projectId: project.id, runtime: 'manual' })
  runId = (await manager.run(session.id, { text: 'Run tools' })).runId
  await adapter.waitStarted(runId)
})
afterEach(async () => {
  await manager.dispose()
  await rm(dir, { force: true, recursive: true })
})
test('persists individual decisions and submits one ordered mixed batch only when complete', async () => {
  await adapter.push(runId, {
    kind: 'approval-batch',
    request: {
      ...batch,
      requests: batch.requests.map((request) => ({ ...request, allowedDecisions: [...request.allowedDecisions] }))
    }
  })
  const requests = await manager.listPendingApprovals(runId)
  const first = requests.find(({ batchIndex }) => batchIndex === 0)
  const second = requests.find(({ batchIndex }) => batchIndex === 1)
  if (!(first && second)) {
    throw new Error('Missing batch members')
  }
  expect(first.batchId).toBe(second.batchId)
  await manager.respondApproval(runId, second.id, 'deny')
  expect(adapter.batches).toHaveLength(0)
  expect((await manager.listPendingApprovals(runId)).find(({ id }) => id === second.id)?.status).toBe('decided')
  const responses = await Promise.allSettled([1, 2].map(() => manager.respondApproval(runId, first.id, 'approve')))
  expect(responses.filter(({ status }) => status === 'fulfilled')).toHaveLength(1)
  expect(adapter.batches).toEqual([
    {
      decisions: [
        { decision: 'approve', nativeRequestId: 'a' },
        { decision: 'deny', nativeRequestId: 'b' }
      ],
      nativeRequestId: 'batch',
      runId
    }
  ])
  expect(await manager.listPendingApprovals(runId)).toEqual([])
  expect((await manager.getRun(runId)).status).toBe('running')
})

test('retains uncertain batches without repeating submission and expires them on cancel', async () => {
  await adapter.push(runId, {
    kind: 'approval-batch',
    request: {
      ...batch,
      requests: batch.requests.map((request) => ({ ...request, allowedDecisions: [...request.allowedDecisions] }))
    }
  })
  const requests = await manager.listPendingApprovals(runId)
  const first = requests[0]
  const second = requests[1]
  if (!(first && second)) {
    throw new Error('Missing batch')
  }
  const session = await manager.getSession((await manager.getRun(runId)).sessionId)
  const other = await manager.createSession({
    cwd: dir,
    model: 'test',
    projectId: session.projectId,
    runtime: 'manual'
  })
  const otherRun = await manager.run(other.id, { text: 'other' })
  await adapter.waitStarted(otherRun.runId)
  await expect(manager.respondApproval(otherRun.runId, first.id, 'approve')).rejects.toMatchObject({
    code: 'APPROVAL_NOT_FOUND'
  })
  adapter.batchError = new Error('Disconnected after send')
  await manager.respondApproval(runId, first.id, 'approve')
  await expect(manager.respondApproval(runId, second.id, 'deny')).rejects.toMatchObject({
    code: 'APPROVAL_RESPONSE_UNCERTAIN'
  })
  await expect(manager.respondApproval(runId, second.id, 'deny')).rejects.toMatchObject({
    code: 'APPROVAL_NOT_PENDING'
  })
  expect(adapter.batches).toHaveLength(1)
  expect((await manager.listPendingApprovals(runId)).every(({ status }) => status === 'responding')).toBe(true)
  await manager.cancel(runId)
  await Array.fromAsync(manager.subscribe(runId))
  expect(await manager.listPendingApprovals(runId)).toEqual([])
  await expect(manager.respondApproval(runId, first.id, 'approve')).rejects.toMatchObject({
    code: 'APPROVAL_NOT_PENDING'
  })
})

test.each([false, true])(
  'recovery expires partially decided or uncertain batches (submitted=%s)',
  async (submitted) => {
    const sessionId = (await manager.getRun(runId)).sessionId
    await manager.cancel(runId)
    await Array.fromAsync(manager.subscribe(runId))
    await manager.dispose()
    const store = await SessionStore.open(dir)
    await store.beginRun(sessionId, 'interrupted')
    await store.requestApprovalBatch('interrupted', {
      ...batch,
      requests: batch.requests.map((request) => ({ ...request, allowedDecisions: [...request.allowedDecisions] }))
    })
    const requests = await store.listPendingApprovals('interrupted')
    const first = requests[0]
    const second = requests[1]
    if (!(first && second)) {
      throw new Error('Missing batch')
    }
    await store.claimApproval('interrupted', first.id, 'approve')
    if (submitted) {
      await store.claimApproval('interrupted', second.id, 'deny')
    }
    await store.close()
    adapter = new ManualAdapter()
    manager = await RuntimeManager.open({ dataDir: dir, runtimes: [adapter] })
    expect((await manager.getRun('interrupted')).status).toBe('interrupted')
    expect(await manager.listPendingApprovals('interrupted')).toEqual([])
    expect(adapter.batches).toHaveLength(0)
    await expect(manager.respondApproval('interrupted', first.id, 'approve')).rejects.toMatchObject({
      code: 'APPROVAL_NOT_PENDING'
    })
  }
)

test('allows reused member IDs in later batches and never resolves a batch as a single approval', async () => {
  for (const nativeRequestId of ['batch-one', 'batch-two']) {
    await adapter.push(runId, {
      kind: 'approval-batch',
      request: {
        nativeRequestId,
        requests: batch.requests.map((request) => ({ ...request, allowedDecisions: [...request.allowedDecisions] }))
      }
    })
    await adapter.push(runId, { kind: 'approval-resolved', nativeRequestId: 'a' })
    const pending = await manager.listPendingApprovals(runId)
    expect(pending).toHaveLength(2)
    await Promise.all(pending.map(({ id }) => manager.respondApproval(runId, id, 'deny')))
  }
  expect(adapter.batches.map(({ nativeRequestId }) => nativeRequestId)).toEqual(['batch-one', 'batch-two'])
})
