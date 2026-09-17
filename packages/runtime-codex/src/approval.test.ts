import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { RuntimeManager } from '@qingshaner/runtime'
import { afterEach, describe, expect, test } from 'vitest'

import type { AdapterNotice, RuntimeAdapter } from '@qingshaner/runtime'

import { closePeers, done, input, peer, turn } from '../test/runtime-peer'

const request = (id: string | number, extra = {}) => ({
  id,
  method: 'item/commandExecution/requestApproval',
  params: { command: 'echo safe', itemId: 'tool', threadId: 'native', turnId: 'turn', ...extra }
})

afterEach(closePeers)

describe('Codex approvals', () => {
  test.each(['commandExecution', 'fileChange'])(
    'sends %s response only once and awaits native confirmation',
    async (kind) => {
      const p = await peer()
      const session = await p.create()
      const received = Promise.withResolvers<void>()
      const notices: AdapterNotice[] = []
      const execution = p.runtime.execute(session, input, (n) => {
        notices.push(n)
        if (n.kind === 'approval') {
          received.resolve()
        }
        return Promise.resolve()
      })
      const start = await p.request('turn/start')
      await p.send({ id: start.id, result: { turn: turn('turn') } })
      await p.send({ ...request(0), method: `item/${kind}/requestApproval` })
      await received.promise
      expect(notices.at(-1)).toMatchObject({
        kind: 'approval',
        request: { allowedDecisions: ['approve', 'deny'], nativeRequestId: 0 }
      })
      let settled = false
      const response = p.runtime.respondApproval('run', 0, 'approve').then(() => {
        settled = true
      })
      expect(await p.request()).toEqual({ id: 0, result: { decision: 'accept' } })
      expect(settled).toBe(false)
      await expect(p.runtime.respondApproval('run', 0, 'deny')).rejects.toMatchObject({ code: 'APPROVAL_NOT_PENDING' })
      await p.send({ method: 'serverRequest/resolved', params: { requestId: 0, threadId: 'native' } })
      await response
      expect(notices.at(-1)).toEqual({ kind: 'approval-resolved', nativeRequestId: 0, responseAttempted: true })
      await p.send(done())
      expect(await execution).toEqual({ status: 'succeeded' })
    }
  )
  test('preserves numeric versus string requests and restricts unavailable accept decisions', async () => {
    const p = await peer()
    const session = await p.create()
    const received = Promise.withResolvers<void>()
    const notices: AdapterNotice[] = []
    const execution = p.runtime.execute(session, input, (n) => {
      notices.push(n)
      if (notices.filter((n) => n.kind === 'approval').length === 2) {
        received.resolve()
      }
      return Promise.resolve()
    })
    const start = await p.request('turn/start')
    await p.send({ id: start.id, result: { turn: turn('turn') } })
    await p.send(request(0))
    await p.send(request('0', { availableDecisions: ['decline', 'cancel'] }))
    await received.promise
    expect(notices.at(-1)).toMatchObject({
      kind: 'approval',
      request: { allowedDecisions: ['deny'], nativeRequestId: '0' }
    })
    await expect(p.runtime.respondApproval('run', '0', 'approve')).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    const response = p.runtime.respondApproval('run', 0, 'approve')
    expect(await p.request()).toEqual({ id: 0, result: { decision: 'accept' } })
    await p.send({ method: 'serverRequest/resolved', params: { requestId: 0, threadId: 'native' } })
    await response
    const other = p.runtime.respondApproval('run', '0', 'deny')
    expect(await p.request()).toEqual({ id: '0', result: { decision: 'decline' } })
    await p.send({ method: 'serverRequest/resolved', params: { requestId: '0', threadId: 'native' } })
    await other
    await p.send(done())
    await execution
  })
  test('keeps a timed-out response non-repeatable and accepts late confirmation', async () => {
    const p = await peer(250)
    const session = await p.create()
    const received = Promise.withResolvers<void>()
    const resolved = Promise.withResolvers<void>()
    const execution = p.runtime.execute(session, input, (n) => {
      if (n.kind === 'approval') {
        received.resolve()
      }
      if (n.kind === 'approval-resolved') {
        resolved.resolve()
      }
      return Promise.resolve()
    })
    const start = await p.request('turn/start')
    await p.send({ id: start.id, result: { turn: turn('turn') } })
    await p.send(request(0))
    await received.promise
    const response = expect(p.runtime.respondApproval('run', 0, 'deny')).rejects.toMatchObject({
      code: 'APPROVAL_RESPONSE_UNCERTAIN'
    })
    expect(await p.request()).toEqual({ id: 0, result: { decision: 'decline' } })
    await response
    await expect(p.runtime.respondApproval('run', 0, 'deny')).rejects.toMatchObject({ code: 'APPROVAL_NOT_PENDING' })
    await p.send({ method: 'serverRequest/resolved', params: { requestId: 0, threadId: 'native' } })
    await resolved.promise
    await p.send(done())
    await execution
  })
  test.each([
    ['mcpServer/elicitation/request', { _meta: null, action: 'decline', content: null }],
    ['item/permissions/requestApproval', { permissions: {}, scope: 'turn' }]
  ])('safely answers unsupported %s with the generated protocol', async (method, result) => {
    const p = await peer()
    await p.create()
    await p.send({ id: 'unsupported', method, params: { threadId: 'native' } })
    expect(await p.request()).toEqual({ id: 'unsupported', result })
  })
  test('closes untrusted transport after replying method-not-found to a request without a matching run', async () => {
    const p = await peer()
    await p.create()
    await p.send({ id: 'unknown', method: 'unknown/request', params: {} })
    expect(await p.request()).toMatchObject({ error: { code: -32601 }, id: 'unknown' })
    await p.closed()
  })
  test('surfaces deferred interrupt timeout without closing the shared child', async () => {
    const p = await peer(250)
    const session = await p.create()
    const execution = p.runtime.execute(session, input, async () => {})
    const start = await p.request('turn/start')
    const cancellation = expect(p.runtime.cancel('run')).rejects.toMatchObject({ code: 'CANCEL_TIMEOUT' })
    await p.send({ id: start.id, result: { turn: turn('turn') } })
    await p.request('turn/interrupt')
    await cancellation
    await p.create('second')
    expect(p.connections()).toBe(1)
    await p.send(done('native', 'turn', 'interrupted'))
    expect(await execution).toEqual({ status: 'cancelled' })
  })
  test('orders native resolution after blocked approval persistence', async () => {
    const p = await peer()
    const session = await p.create()
    const entered = Promise.withResolvers<void>()
    const gate = Promise.withResolvers<void>()
    const resolved = Promise.withResolvers<void>()
    const notices: AdapterNotice[] = []
    const execution = p.runtime.execute(session, input, async (notice) => {
      if (notice.kind === 'approval') {
        entered.resolve()
        await gate.promise
      }
      notices.push(notice)
      if (notice.kind === 'approval-resolved') {
        resolved.resolve()
      }
    })
    const start = await p.request('turn/start')
    await p.send({ id: start.id, result: { turn: turn('turn') } })
    await p.send(request(0))
    await entered.promise
    await p.send({ method: 'serverRequest/resolved', params: { requestId: 0, threadId: 'native' } })
    // A separate request/reply proves the adapter consumed the preceding notification.
    await p.create('barrier')
    expect(notices.map((n) => n.kind)).toEqual(['started'])
    gate.resolve()
    await resolved.promise
    expect(notices.map((n) => n.kind)).toEqual(['started', 'approval', 'approval-resolved'])
    await p.send(done())
    await execution
  })
  test('waits for resolution persistence before acknowledging a response', async () => {
    const p = await peer()
    const session = await p.create()
    const received = Promise.withResolvers<void>()
    const entered = Promise.withResolvers<void>()
    const gate = Promise.withResolvers<void>()
    const execution = p.runtime.execute(session, input, async (notice) => {
      if (notice.kind === 'approval') {
        received.resolve()
      }
      if (notice.kind === 'approval-resolved') {
        entered.resolve()
        await gate.promise
      }
    })
    const start = await p.request('turn/start')
    await p.send({ id: start.id, result: { turn: turn('turn') } })
    await p.send(request(0))
    await received.promise
    let settled = false
    const response = p.runtime.respondApproval('run', 0, 'deny').then(() => {
      settled = true
    })
    await p.request()
    await p.send({ method: 'serverRequest/resolved', params: { requestId: 0, threadId: 'native' } })
    await entered.promise
    expect(settled).toBe(false)
    gate.resolve()
    await response
    await p.send(done())
    await execution
  })
  test('fails only the associated run for an unknown native request', async () => {
    const p = await peer()
    const session = await p.create()
    const execution = p.runtime.execute(session, input, async () => {})
    const start = await p.request('turn/start')
    await p.send({ id: start.id, result: { turn: turn('turn') } })
    await p.send({ id: 'unknown', method: 'unknown/request', params: { threadId: 'native', turnId: 'turn' } })
    expect(await p.request()).toMatchObject({ error: { code: -32601 }, id: 'unknown' })
    const interrupt = await p.request('turn/interrupt')
    await p.send({ id: interrupt.id, result: {} })
    await p.send(done('native', 'turn', 'interrupted'))
    expect(await execution).toMatchObject({ error: { code: 'UNSUPPORTED_REQUEST' }, status: 'failed' })
    await p.create('second')
    expect(p.connections()).toBe(1)
  })
  test('rejects an unconfirmed response when the turn terminates', async () => {
    const p = await peer()
    const session = await p.create()
    const received = Promise.withResolvers<void>()
    const execution = p.runtime.execute(session, input, (notice) => {
      if (notice.kind === 'approval') {
        received.resolve()
      }
      return Promise.resolve()
    })
    const start = await p.request('turn/start')
    await p.send({ id: start.id, result: { turn: turn('turn') } })
    await p.send(request(0))
    await received.promise
    const response = expect(p.runtime.respondApproval('run', 0, 'deny')).rejects.toMatchObject({
      code: 'APPROVAL_RESPONSE_UNCERTAIN'
    })
    await p.request()
    await p.send(done('native', 'turn', 'interrupted'))
    await response
    expect(await execution).toEqual({ status: 'cancelled' })
  })
  test('expires a native self-resolution racing a durable response claim without sending a reply', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'runtime-approval-race-'))
    const p = await peer()
    const native = await p.create('native', 'race')
    const resolutionEntered = Promise.withResolvers<void>()
    const releaseResolution = Promise.withResolvers<void>()
    const approvalPersisted = Promise.withResolvers<void>()
    const adapter: RuntimeAdapter = {
      cancel: (runId) => p.runtime.cancel(runId),
      createSession: () => Promise.resolve(native),
      dispose: () => p.runtime.dispose(),
      execute: (session, input, emit) =>
        p.runtime.execute(session, input, async (notice) => {
          if (notice.kind === 'approval-resolved') {
            resolutionEntered.resolve()
            await releaseResolution.promise
          }
          await emit(notice)
          if (notice.kind === 'approval') {
            approvalPersisted.resolve()
          }
        }),
      kind: p.runtime.kind,
      respondApproval: (runId, requestId, decision) => p.runtime.respondApproval(runId, requestId, decision),
      resumeSession: (session) => p.runtime.resumeSession(session)
    }
    const manager = await RuntimeManager.open({ dataDir: dir, runtimes: [adapter] })
    try {
      await manager.createProject({ id: 'race', name: 'race' })
      const session = await manager.createSession({
        cwd: dir,
        model: 'model-test',
        projectId: 'race',
        runtime: adapter.kind
      })
      const { runId } = await manager.run(session.id, { text: 'hello' })
      const start = await p.request('turn/start')
      await p.send({ id: start.id, result: { turn: turn('turn') } })
      await p.send(request(0))
      await approvalPersisted.promise
      const [approval] = await manager.listPendingApprovals(runId)
      if (!approval) {
        throw new Error('Missing approval')
      }
      await p.send({ method: 'serverRequest/resolved', params: { requestId: 0, threadId: 'native' } })
      await resolutionEntered.promise
      await expect(manager.respondApproval(runId, approval.id, 'approve')).rejects.toMatchObject({
        code: 'APPROVAL_RESPONSE_UNCERTAIN'
      })
      expect(await manager.listPendingApprovals(runId)).toMatchObject([{ decision: 'approve', status: 'responding' }])
      // The next received frame must be thread/start, so no native approval response was sent.
      await p.create('wire-barrier', 'race')
      releaseResolution.resolve()
      await p.send(done())
      const events = []
      for await (const envelope of manager.subscribe(runId)) {
        events.push(envelope.event)
      }
      const resolved = events.filter((event) => event.type === 'CUSTOM' && event.name === 'runtime.approval.resolved')
      expect(resolved).toEqual([
        {
          name: 'runtime.approval.resolved',
          type: 'CUSTOM',
          value: { approvalId: approval.id, decision: null, status: 'expired' }
        }
      ])
      await expect(manager.respondApproval(runId, approval.id, 'approve')).rejects.toMatchObject({
        code: 'APPROVAL_NOT_PENDING'
      })
      await p.create('end-barrier', 'race')
    } finally {
      releaseResolution.resolve()
      await manager.dispose()
      await rm(dir, { force: true, recursive: true })
    }
  })
})
