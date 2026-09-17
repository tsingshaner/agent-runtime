import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { ManualAdapter } from '../test/manual-adapter'
import { RuntimeError } from './errors'
import { RuntimeManager } from './manager'
import { SessionStore } from './store'

describe('recoverable approvals and cancellation', () => {
  let dir: string
  let manager: RuntimeManager
  let adapter: ManualAdapter
  let runId: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'runtime-approvals-'))
    adapter = new ManualAdapter()
    manager = await RuntimeManager.open({ dataDir: dir, runtimes: [adapter] })
    await manager.createProject({ id: 'test', name: 'test' })
    const session = await manager.createSession({ cwd: dir, model: 'model-test', projectId: 'test', runtime: 'manual' })
    runId = (await manager.run(session.id, { text: 'hello' })).runId
    await adapter.waitStarted(runId)
    await adapter.push(runId, { kind: 'started', nativeTurnId: 'native-turn' })
  })
  afterEach(async () => {
    await manager.dispose()
    await rm(dir, { force: true, recursive: true })
  })
  const request = (id: string | number = 0) =>
    adapter.push(runId, {
      kind: 'approval',
      request: {
        allowedDecisions: ['approve', 'deny'],
        detail: { command: 'echo safe' },
        kind: 'command',
        nativeRequestId: id
      }
    })
  test('responds after disconnect and persists a public approval event without native identity', async () => {
    const iterator = manager.subscribe(runId)[Symbol.asyncIterator]()
    await iterator.next()
    await iterator.return?.()
    await request()
    const [approval] = await manager.listPendingApprovals(runId)
    if (!approval) {
      throw new Error('Missing approval')
    }
    expect(approval).toMatchObject({ nativeRequestId: 0, status: 'pending' })
    expect((await manager.getRun(runId)).status).toBe('waiting_approval')
    const replay = manager.subscribe(runId, { afterSequence: 1 })[Symbol.asyncIterator]()
    const event = (await replay.next()).value?.event
    expect(event).toMatchObject({ name: 'runtime.approval.requested', type: 'CUSTOM', value: { id: approval.id } })
    expect(event.value).not.toHaveProperty('nativeRequestId')
    await replay.return?.()
    await manager.respondApproval(runId, approval.id, 'deny')
    await expect(manager.respondApproval(runId, approval.id, 'deny')).rejects.toMatchObject({
      code: 'APPROVAL_NOT_PENDING'
    })
    expect(adapter.decisions).toEqual([{ decision: 'deny', nativeRequestId: 0, runId }])
    expect((await manager.getRun(runId)).status).toBe('running')
  })
  test('atomically sends a concurrent response once', async () => {
    await request()
    const [approval] = await manager.listPendingApprovals(runId)
    if (!approval) {
      throw new Error('Missing approval')
    }
    const results = await Promise.allSettled([
      manager.respondApproval(runId, approval.id, 'approve'),
      manager.respondApproval(runId, approval.id, 'deny')
    ])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({ reason: { code: 'APPROVAL_NOT_PENDING' } })
    expect(adapter.decisions).toHaveLength(1)
  })
  test('rejects cross-run approval identity without sending', async () => {
    await request()
    const [approval] = await manager.listPendingApprovals(runId)
    if (!approval) {
      throw new Error('Missing approval')
    }
    const other = await manager.createSession({ cwd: dir, model: 'model-test', projectId: 'test', runtime: 'manual' })
    const otherRun = await manager.run(other.id, { text: 'other' })
    await adapter.waitStarted(otherRun.runId)
    await expect(manager.respondApproval(otherRun.runId, approval.id, 'approve')).rejects.toMatchObject({
      code: 'APPROVAL_NOT_FOUND'
    })
    expect(adapter.decisions).toEqual([])
  })
  test('keeps number and string identities separate and waits for all approvals', async () => {
    await request(0)
    await request('0')
    const pending = await manager.listPendingApprovals(runId)
    expect(pending.map((a) => a.nativeRequestId)).toEqual(expect.arrayContaining([0, '0']))
    await manager.respondApproval(runId, pending[0]?.id ?? 'missing', 'approve')
    expect((await manager.getRun(runId)).status).toBe('waiting_approval')
    await manager.respondApproval(runId, pending[1]?.id ?? 'missing', 'deny')
    expect((await manager.getRun(runId)).status).toBe('running')
  })
  test('expires an unanswered request on native resolution', async () => {
    await request()
    const [approval] = await manager.listPendingApprovals(runId)
    if (!approval) {
      throw new Error('Missing approval')
    }
    await adapter.push(runId, { kind: 'approval-resolved', nativeRequestId: 0 })
    expect(await manager.listPendingApprovals(runId)).toEqual([])
    const replay = manager.subscribe(runId, { afterSequence: 2 })[Symbol.asyncIterator]()
    expect((await replay.next()).value?.event).toMatchObject({
      name: 'runtime.approval.resolved',
      value: { approvalId: approval.id, decision: null, status: 'expired' }
    })
    await replay.return?.()
  })
  test('keeps uncertain responses non-repeatable until native confirmation', async () => {
    await request()
    const [approval] = await manager.listPendingApprovals(runId)
    if (!approval) {
      throw new Error('Missing approval')
    }
    adapter.approvalError = new Error('write failed')
    await expect(manager.respondApproval(runId, approval.id, 'deny')).rejects.toMatchObject({
      code: 'APPROVAL_RESPONSE_UNCERTAIN'
    })
    expect(await manager.listPendingApprovals(runId)).toMatchObject([{ decision: 'deny', status: 'responding' }])
    await expect(manager.respondApproval(runId, approval.id, 'deny')).rejects.toMatchObject({
      code: 'APPROVAL_NOT_PENDING'
    })
    await adapter.push(runId, { kind: 'approval-resolved', nativeRequestId: 0 })
    expect(await manager.listPendingApprovals(runId)).toEqual([])
  })
  test('expires approvals on cancellation and makes terminal cancellation a no-op', async () => {
    await request()
    await Promise.all([manager.cancel(runId), manager.cancel(runId)])
    for await (const _event of manager.subscribe(runId)) {
      /* drain */
    }
    expect((await manager.getRun(runId)).status).toBe('cancelled')
    expect(await manager.listPendingApprovals(runId)).toEqual([])
    await manager.cancel(runId)
    expect(adapter.cancelled).toEqual([runId])
  })
  test('retains cancellation while resume has not installed execution routing', async () => {
    let release!: () => void
    adapter.resumeGate = new Promise<void>((resolve) => {
      release = resolve
    })
    const session = await manager.createSession({ cwd: dir, model: 'model-test', projectId: 'test', runtime: 'manual' })
    const early = await manager.run(session.id, { text: 'early' })
    const cancellation = manager.cancel(early.runId)
    // Store read is a transaction barrier after markCancelling.
    expect((await manager.getRun(early.runId)).status).toBe('cancelling')
    release()
    await cancellation
    for await (const _event of manager.subscribe(early.runId)) {
      /* drain */
    }
    expect((await manager.getRun(early.runId)).status).toBe('cancelled')
    expect(adapter.cancelled).toEqual([early.runId])
  })
  test('keeps cancellation and session ownership after interrupt timeout', async () => {
    adapter.cancelError = new RuntimeError('RPC_TIMEOUT', 'No interrupt ACK')
    await expect(manager.cancel(runId)).rejects.toMatchObject({ code: 'CANCEL_TIMEOUT' })
    const run = await manager.getRun(runId)
    expect(run.status).toBe('cancelling')
    await expect(manager.run(run.sessionId, { text: 'second' })).rejects.toMatchObject({ code: 'SESSION_BUSY' })
    await request()
    const [approval] = await manager.listPendingApprovals(runId)
    if (!approval) {
      throw new Error('Missing approval')
    }
    await manager.respondApproval(runId, approval.id, 'deny')
    expect((await manager.getRun(runId)).status).toBe('cancelling')
    adapter.finish(runId, { status: 'succeeded' })
    for await (const _event of manager.subscribe(runId)) {
      /* drain */
    }
    expect((await manager.getRun(runId)).status).toBe('succeeded')
  })
  test('does not equate interrupt ACK with terminal completion', async () => {
    adapter.finishOnCancel = false
    await manager.cancel(runId)
    expect((await manager.getRun(runId)).status).toBe('cancelling')
    adapter.finish(runId, { status: 'cancelled' })
    for await (const _event of manager.subscribe(runId)) {
      /* drain */
    }
    expect((await manager.getRun(runId)).status).toBe('cancelled')
  })
  test('rejects disallowed decisions without claiming the approval', async () => {
    await adapter.push(runId, {
      kind: 'approval',
      request: { allowedDecisions: ['deny'], detail: {}, kind: 'command', nativeRequestId: 1 }
    })
    const [approval] = await manager.listPendingApprovals(runId)
    if (!approval) {
      throw new Error('Missing approval')
    }
    await expect(manager.respondApproval(runId, approval.id, 'approve')).rejects.toMatchObject({
      code: 'INVALID_INPUT'
    })
    expect(await manager.listPendingApprovals(runId)).toMatchObject([{ decision: null, status: 'pending' }])
    expect(adapter.decisions).toEqual([])
  })
})

describe('approval durability', () => {
  test('retains pending and responding approvals when the store reopens', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'runtime-approval-durable-'))
    let store = await SessionStore.open(dir)
    try {
      await store.insertSession({
        cwd: dir,
        id: 'session',
        nativeSessionId: 'native',
        options: {},
        projectId: 'project',
        runtime: 'manual',
        title: 'test'
      })
      await store.beginRun('session', 'run')
      const pending = await store.requestApproval('run', {
        allowedDecisions: ['approve', 'deny'],
        detail: {},
        kind: 'command',
        nativeRequestId: 0
      })
      const responding = await store.requestApproval('run', {
        allowedDecisions: ['deny'],
        detail: {},
        kind: 'file-change',
        nativeRequestId: '0'
      })
      await store.claimApproval('run', responding.id, 'deny')
      await store.close()
      store = await SessionStore.open(dir)
      expect(await store.listPendingApprovals('run')).toEqual(
        expect.arrayContaining([pending, { ...responding, decision: 'deny', status: 'responding' }])
      )
      await expect(store.claimApproval('run', responding.id, 'deny')).rejects.toMatchObject({
        code: 'APPROVAL_NOT_PENDING'
      })
      expect(await store.readEventPage('run', 0)).toHaveLength(3)
    } finally {
      await store.close()
      await rm(dir, { force: true, recursive: true })
    }
  })
})
