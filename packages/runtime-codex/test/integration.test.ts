import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { RuntimeManager } from '@qingshaner/runtime'
import { afterEach, describe, expect, expectTypeOf, test, vi } from 'vitest'

import { closePeers, delta, done, peer, turn } from './runtime-peer'

const directories: string[] = []
const managers: RuntimeManager[] = []
afterEach(async () => {
  for (const manager of managers.splice(0).reverse()) {
    await manager.dispose()
  }
  await closePeers()
  for (const directory of directories.splice(0)) {
    await rm(directory, { force: true, recursive: true })
  }
})
const setup = async (directory?: string) => {
  const dir = directory ?? (await mkdtemp(join(tmpdir(), 'runtime-integration-')))
  if (!directory) {
    directories.push(dir)
  }
  const remote = await peer(1000, dir)
  const manager = await RuntimeManager.open({ dataDir: join(dir, 'data'), runtimes: [remote.runtime] })
  if (!directory) {
    await manager.createProject({ id: 'demo', name: 'demo' })
  }
  managers.push(manager)
  return { dir, manager, remote }
}
const create = async (context: Awaited<ReturnType<typeof setup>>, id = 'native') => {
  const pending = context.manager.createSession({
    cwd: context.dir,
    model: 'session-model',
    projectId: 'demo',
    runtime: 'codex'
  })
  if (context.remote.connections() === 0) {
    await context.remote.handshake()
  }
  const frame = await context.remote.request('thread/start')
  // biome-ignore lint/suspicious/noMisplacedAssertion: Integration protocol invariant.
  expect(frame.params).toMatchObject({
    approvalPolicy: 'on-request',
    ephemeral: false,
    model: 'session-model',
    sandbox: 'workspace-write'
  })
  await context.remote.send({ id: frame.id, result: { cwd: context.dir, model: 'session-model', thread: { id } } })
  return pending
}

describe('public Codex SDK integration', () => {
  test('rejects invalid native options through the Manager before process startup', async () => {
    const context = await setup()
    await expect(
      context.manager.createSession({
        cwd: context.dir,
        model: 'session-model',
        options: { sandbox: 'danger-full-access' },
        projectId: 'demo',
        runtime: 'codex'
      } as never)
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(context.remote.connections()).toBe(0)
    expect((await context.manager.listSessions()).items).toEqual([])
  })

  test('answers a native input request through the durable Manager API', async () => {
    const context = await setup()
    const session = await create(context)
    const { runId } = await context.manager.run(session.id, { text: 'Ask me' })
    const start = await context.remote.request('turn/start')
    await context.remote.send({ id: start.id, result: { turn: turn('turn') } })
    await context.remote.send({
      id: 'input-1',
      method: 'item/tool/requestUserInput',
      params: {
        autoResolutionMs: null,
        isBlocking: true,
        itemId: 'item',
        questions: [
          { header: 'Choice', id: 'choice', isOther: true, isSecret: false, options: null, question: 'Which?' }
        ],
        threadId: session.nativeSessionId,
        turnId: 'turn'
      }
    })
    await vi.waitFor(async () => expect((await context.manager.listPendingInputs(runId)).length).toBe(1))
    const [input] = await context.manager.listPendingInputs(runId)
    if (!input) {
      throw new Error('Missing input')
    }
    const answering = context.manager.respondInput(runId, input.id, { choice: ['mine'] })
    expect((await context.remote.request()).result).toEqual({ answers: { choice: { answers: ['mine'] } } })
    await context.remote.send({
      method: 'serverRequest/resolved',
      params: { requestId: 'input-1', threadId: session.nativeSessionId }
    })
    await answering
    expect((await context.manager.getRun(runId)).status).toBe('running')
    await context.remote.send(done(session.nativeSessionId, 'turn'))
    await Array.fromAsync(context.manager.subscribe(runId))
    expect((await context.manager.getRun(runId)).status).toBe('succeeded')
  })

  test('a fresh manager resumes a persisted public session', async () => {
    const first = await setup()
    expectTypeOf<Parameters<typeof first.manager.createSession>[0]>().toEqualTypeOf<{
      runtime: 'codex'
      model: string
      projectId: string
      cwd: string
      title?: string
      options?: { approvalPolicy?: 'on-request' | 'never'; sandbox?: 'read-only' | 'workspace-write' }
    }>()
    const session = await create(first)
    expect(session.model).toBe('session-model')
    expect(session.options).toEqual({ approvalPolicy: 'on-request', sandbox: 'workspace-write' })
    expect(JSON.parse(await readFile(join(first.dir, 'threads.json'), 'utf8'))).toEqual([session.nativeSessionId])
    await first.manager.dispose()
    const second = await setup(first.dir)
    const pending = second.manager.resumeSession(session.id)
    await second.remote.handshake()
    const frame = await second.remote.request('thread/resume')
    expect(frame.params).toMatchObject({
      model: 'session-model',
      sandbox: 'workspace-write',
      threadId: session.nativeSessionId
    })
    await second.remote.send({
      id: frame.id,
      result: { cwd: first.dir, model: 'session-model', thread: { id: session.nativeSessionId } }
    })
    await expect(pending).resolves.toMatchObject({ id: session.id, nativeSessionId: session.nativeSessionId })
    const unknown = second.remote.runtime.resumeSession({
      cwd: first.dir,
      nativeSessionId: 'unknown',
      options: {},
      projectId: session.projectId
    })
    const rejected = expect(unknown).rejects.toMatchObject({ code: 'RPC_ERROR' })
    expect((await second.remote.request('thread/resume')).params.threadId).toBe('unknown')
    await rejected
  })

  test('replays persisted output generated after the subscriber disconnects', async () => {
    const context = await setup()
    const session = await create(context)
    const { runId } = await context.manager.run(session.id, { text: 'hello' })
    const frame = await context.remote.request('turn/start')
    // biome-ignore lint/style/useNamingConvention: Native protocol field.
    expect(frame.params).toEqual({ input: [{ text: 'hello', text_elements: [], type: 'text' }], threadId: 'native' })
    await context.remote.send({ id: frame.id, result: { turn: turn('turn') } })
    const iterator = context.manager.subscribe(runId)[Symbol.asyncIterator]()
    const first = await iterator.next()
    expect(first.value).toMatchObject({ event: { type: 'RUN_STARTED' }, runId, sequence: 1, sessionId: session.id })
    await iterator.return?.()
    await context.remote.send(delta())
    await context.remote.send(done())
    await expect.poll(() => context.manager.getRun(runId)).toMatchObject({ lastSequence: 5, status: 'succeeded' })
    const replay = await Array.fromAsync(context.manager.subscribe(runId, { afterSequence: 1 }))
    expect(replay.map(({ sequence }) => sequence)).toEqual([2, 3, 4, 5])
    expect(replay.map(({ event }) => event.type)).toEqual([
      'TEXT_MESSAGE_START',
      'TEXT_MESSAGE_CONTENT',
      'TEXT_MESSAGE_END',
      'RUN_FINISHED'
    ])
    expect(replay[1]?.event).toMatchObject({ delta: 'hello' })
    await expect(context.manager.getRun(runId)).resolves.toMatchObject({ lastSequence: 5, status: 'succeeded' })
    expect(await Array.fromAsync(context.manager.subscribe(runId))).toEqual([first.value, ...replay])
  })

  test('denies approval and cancels only the selected session', async () => {
    const context = await setup()
    const first = await create(context)
    const second = await create(context, 'other')
    const a = await context.manager.run(first.id, { text: 'write a file' })
    const startA = await context.remote.request('turn/start')
    await context.remote.send({ id: startA.id, result: { turn: turn('turn') } })
    const b = await context.manager.run(second.id, { text: 'keep going' })
    const startB = await context.remote.request('turn/start')
    await context.remote.send({ id: startB.id, result: { turn: turn('other-turn') } })
    await context.remote.send({
      id: 'approval',
      method: 'item/fileChange/requestApproval',
      params: { itemId: 'file', threadId: 'native', turnId: 'turn' }
    })
    for await (const envelope of context.manager.subscribe(a.runId)) {
      if (envelope.event.type === 'CUSTOM' && envelope.event.name === 'runtime.approval.requested') {
        break
      }
    }
    const [approval] = await context.manager.listPendingApprovals(a.runId)
    expect(approval).toMatchObject({ kind: 'file-change', status: 'pending' })
    if (!approval) {
      throw new Error('Missing approval')
    }
    const responding = context.manager.respondApproval(a.runId, approval.id, 'deny')
    expect(await context.remote.request()).toEqual({ id: 'approval', result: { decision: 'decline' } })
    await context.remote.send({
      method: 'serverRequest/resolved',
      params: { requestId: 'approval', threadId: 'native' }
    })
    await responding
    const cancelling = context.manager.cancel(a.runId)
    const interrupt = await context.remote.request('turn/interrupt')
    expect(interrupt.params).toEqual({ threadId: 'native', turnId: 'turn' })
    await context.remote.send({ id: interrupt.id, result: {} })
    await cancelling
    await expect(context.manager.getRun(a.runId)).resolves.toMatchObject({ status: 'cancelling' })
    await context.remote.send(done('native', 'turn', 'interrupted'))
    await context.remote.send(delta('other', 'other-turn', 'unaffected'))
    await context.remote.send(done('other', 'other-turn'))
    const eventsA = await Array.fromAsync(context.manager.subscribe(a.runId))
    const eventsB = await Array.fromAsync(context.manager.subscribe(b.runId))
    expect(eventsA.every(({ sessionId }) => sessionId === first.id)).toBe(true)
    expect(eventsB.every(({ sessionId }) => sessionId === second.id)).toBe(true)
    expect(eventsA).toContainEqual(
      expect.objectContaining({
        event: expect.objectContaining({
          name: 'runtime.approval.resolved',
          value: { approvalId: approval.id, decision: 'deny', status: 'resolved' }
        })
      })
    )
    expect(eventsB).toContainEqual(expect.objectContaining({ event: expect.objectContaining({ delta: 'unaffected' }) }))
    await expect(context.manager.getRun(a.runId)).resolves.toMatchObject({ status: 'cancelled' })
    await expect(context.manager.getRun(b.runId)).resolves.toMatchObject({ status: 'succeeded' })
    expect(context.remote.connections()).toBe(1)
  })
})
