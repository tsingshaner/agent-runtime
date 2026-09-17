import { afterEach, describe, expect, test } from 'vitest'

import type { AdapterNotice, JsonObject, NativeSession } from '@qingshaner/runtime'

import { closePeers, cwd, delta, done, fakePath, input, peer, turn } from '../test/runtime-peer'
import { CodexRuntime } from './runtime'

afterEach(closePeers)

describe('CodexRuntime', () => {
  test('constructs lazily and shares one handshake across concurrent creation', async () => {
    const p = await peer()
    expect(p.connections()).toBe(0)
    const first = p.runtime.createSession({ cwd })
    const second = p.runtime.createSession({
      cwd,
      options: { approvalPolicy: 'never', model: 'override', sandbox: 'read-only' }
    })
    await p.handshake()
    const requests = [await p.request('thread/start'), await p.request('thread/start')]
    const a = requests.find((frame) => frame.params.model === 'model-test')
    const b = requests.find((frame) => frame.params.model === 'override')
    if (!(a && b)) {
      throw new Error('Missing concurrent start requests')
    }
    expect(a.params).toEqual({
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
      cwd,
      ephemeral: false,
      model: 'model-test',
      sandbox: 'workspace-write'
    })
    expect(b.params).toEqual({
      approvalPolicy: 'never',
      approvalsReviewer: 'user',
      cwd,
      ephemeral: false,
      model: 'override',
      sandbox: 'read-only'
    })
    await p.send({ id: a.id, result: { cwd, model: 'model-test', thread: { id: 'a' } } })
    await p.send({ id: b.id, result: { cwd, model: 'override', thread: { id: 'b' } } })
    expect(await first).toEqual({
      cwd,
      nativeSessionId: 'a',
      options: { approvalPolicy: 'on-request', model: 'model-test', sandbox: 'workspace-write' }
    })
    expect((await second).nativeSessionId).toBe('b')
    expect(p.connections()).toBe(1)
  })

  test.each<JsonObject>([
    { token: 'secret' },
    { sandbox: 'danger-full-access' },
    { model: '' },
    { approvalPolicy: 'auto' }
  ])('rejects unsafe or unknown session options before startup: %j', async (options) => {
    const p = await peer()
    await expect(p.runtime.createSession({ cwd, options })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(p.connections()).toBe(0)
  })

  test('routes early notifications and awaits each emitter before resolving', async () => {
    const p = await peer()
    const session = await p.create()
    const notices: AdapterNotice[] = []
    const gate = Promise.withResolvers<void>()
    const entered = Promise.withResolvers<void>()
    let settled = false
    const execution = p.runtime
      .execute(session, input, async (notice) => {
        notices.push(notice)
        if (notice.kind === 'started') {
          entered.resolve()
          await gate.promise
        }
      })
      .then((result) => {
        settled = true
        return result
      })
    const start = await p.request('turn/start')
    // biome-ignore lint/style/useNamingConvention: Native protocol field.
    expect(start.params).toEqual({ input: [{ text: 'hello', text_elements: [], type: 'text' }], threadId: 'native' })
    await p.send(delta())
    await entered.promise
    await p.send(done())
    await p.send({ id: start.id, result: { turn: turn('turn') } })
    expect(settled).toBe(false)
    expect(notices).toEqual([{ kind: 'started', nativeTurnId: 'turn' }])
    gate.resolve()
    expect(await execution).toEqual({ status: 'succeeded' })
    expect(notices.filter((n) => n.kind === 'event').map((n) => n.event.type)).toEqual([
      'TEXT_MESSAGE_START',
      'TEXT_MESSAGE_CONTENT',
      'TEXT_MESSAGE_END'
    ])
  })

  test('cancels before turn identity arrives once, with native completion winning a race', async () => {
    const p = await peer()
    const session = await p.create()
    const execution = p.runtime.execute(session, input, async () => {})
    const start = await p.request('turn/start')
    const cancellations = [p.runtime.cancel('run'), p.runtime.cancel('run')]
    await p.send({ id: start.id, result: { turn: turn('turn') } })
    const interrupt = await p.request('turn/interrupt')
    expect(interrupt.params).toEqual({ threadId: 'native', turnId: 'turn' })
    await p.send({ id: interrupt.id, result: {} })
    await Promise.all(cancellations)
    await p.send(done())
    expect(await execution).toEqual({ status: 'succeeded' })
    const next = p.runtime.createSession({ cwd })
    const frame = await p.request('thread/start')
    await p.send({ id: frame.id, result: { cwd, model: 'model-test', thread: { id: 'next' } } })
    await next
  })

  test('resumes only the saved identity and propagates failure without starting a replacement', async () => {
    const p = await peer()
    const session: NativeSession = {
      cwd,
      nativeSessionId: 'saved',
      options: { approvalPolicy: 'never', model: 'saved-model', sandbox: 'read-only' }
    }
    const result = expect(p.runtime.resumeSession(session)).rejects.toMatchObject({ code: 'RPC_ERROR' })
    await p.handshake()
    const resume = await p.request('thread/resume')
    expect(resume.params).toEqual({
      approvalPolicy: 'never',
      approvalsReviewer: 'user',
      cwd,
      model: 'saved-model',
      sandbox: 'read-only',
      threadId: 'saved'
    })
    await p.send({ error: { code: -1, message: 'missing' }, id: resume.id })
    await result
    await expect(p.runtime.respondApproval('run', 1, 'approve')).rejects.toMatchObject({ code: 'APPROVAL_NOT_FOUND' })
  })

  test('isolates concurrent threads, ignores old turns and preserves native failed outcomes', async () => {
    const p = await peer()
    const first = await p.create()
    const second = await p.create('other')
    const a: AdapterNotice[] = []
    const b: AdapterNotice[] = []
    const runA = p.runtime.execute(first, input, (notice) => {
      a.push(notice)
      return Promise.resolve()
    })
    const startA = await p.request('turn/start')
    await p.send({ id: startA.id, result: { turn: turn('turn') } })
    const runB = p.runtime.execute(second, { ...input, runId: 'run-b' }, (notice) => {
      b.push(notice)
      return Promise.resolve()
    })
    const startB = await p.request('turn/start')
    await p.send({ id: startB.id, result: { turn: turn('turn-b') } })
    await p.send(delta('native', 'old-turn', 'wrong'))
    await p.send({ method: 'future/notice', params: { threadId: 'native', turnId: 'turn' } })
    await p.send(delta('native', 'turn', 'partial'))
    await p.send(delta('other', 'turn-b', 'other text'))
    await p.send(done('native', 'turn', 'failed'))
    await p.send(done('native', 'turn', 'failed'))
    await p.send(done('other', 'turn-b', 'interrupted'))
    expect(await runA).toEqual({ error: { code: 'RUN_FAILED', message: 'Codex turn failed' }, status: 'failed' })
    expect(await runB).toEqual({ status: 'cancelled' })
    expect(
      a
        .filter((n) => n.kind === 'event' && n.event.type === 'TEXT_MESSAGE_CONTENT')
        .map((n) => n.kind === 'event' && n.event.type === 'TEXT_MESSAGE_CONTENT' && n.event.delta)
    ).toEqual(['partial'])
    expect(
      b
        .filter((n) => n.kind === 'event' && n.event.type === 'TEXT_MESSAGE_CONTENT')
        .map((n) => n.kind === 'event' && n.event.type === 'TEXT_MESSAGE_CONTENT' && n.event.delta)
    ).toEqual(['other text'])
    expect(a.at(-1)).toEqual({ event: { messageId: 'run:message', type: 'TEXT_MESSAGE_END' }, kind: 'event' })
  })

  test('restarts and resumes the saved thread after process exit', async () => {
    const p = await peer()
    const session = await p.create()
    const notices: AdapterNotice[] = []
    const execution = p.runtime.execute(session, input, (notice) => {
      notices.push(notice)
      return Promise.resolve()
    })
    const start = await p.request('turn/start')
    await p.send({ id: start.id, result: { turn: turn('turn') } })
    await p.send(delta())
    // The peer exits without an acknowledgement.
    void p.command({ action: 'exit' })
    expect(await execution).toMatchObject({ error: { code: 'PROCESS_EXITED' }, status: 'failed' })
    expect(notices.at(-1)).toEqual({ event: { messageId: 'run:message', type: 'TEXT_MESSAGE_END' }, kind: 'event' })
    const resuming = p.runtime.resumeSession(session)
    await p.handshake()
    const resume = await p.request('thread/resume')
    expect(resume.params.threadId).toBe('native')
    await p.send({ id: resume.id, result: { cwd, model: 'model-test', thread: { id: 'native' } } })
    await resuming
    expect(p.connections()).toBe(2)
  })

  test.each(['count', 'bytes'])(
    'interrupts a run overflowing the notification %s limit and waits for native termination',
    async (limit) => {
      const p = await peer()
      const session = await p.create()
      const gate = Promise.withResolvers<void>()
      const entered = Promise.withResolvers<void>()
      let settled = false
      const execution = p.runtime
        .execute(session, input, async (notice) => {
          if (notice.kind === 'started') {
            entered.resolve()
            await gate.promise
          }
        })
        .then((value) => {
          settled = true
          return value
        })
      const start = await p.request('turn/start')
      await p.send({ id: start.id, result: { turn: turn('turn') } })
      await entered.promise
      const count = limit === 'count' ? 1024 : 9
      const text = limit === 'count' ? 'x' : 'x'.repeat(1024 * 1024)
      // One control command sends a burst, preserving the real stdout transport.
      await p.command({
        action: 'raw',
        bytes: [
          ...Buffer.from(
            `${Array.from({ length: count }, () => JSON.stringify(delta('native', 'turn', text))).join('\n')}\n`
          )
        ]
      })
      const interrupt = await p.request('turn/interrupt')
      await p.send({ id: interrupt.id, result: {} })
      gate.resolve()
      // A second native operation provides a deterministic barrier after the interrupt ACK.
      const creating = p.runtime.createSession({ cwd })
      const barrier = await p.request('thread/start')
      expect(settled).toBe(false)
      await p.send({ id: barrier.id, result: { cwd, model: 'model-test', thread: { id: 'next' } } })
      await creating
      await p.send(done('native', 'turn', 'interrupted'))
      expect(await execution).toMatchObject({ error: { code: 'STREAM_OVERFLOW' }, status: 'failed' })
    }
  )

  test('closes the shared transport when overflow cannot be safely interrupted', async () => {
    const p = await peer(60)
    const first = await p.create()
    const second = await p.create('other')
    const gate = Promise.withResolvers<void>()
    const entered = Promise.withResolvers<void>()
    const a = p.runtime.execute(first, input, async (notice) => {
      if (notice.kind === 'started') {
        entered.resolve()
        await gate.promise
      }
    })
    const startA = await p.request('turn/start')
    await p.send({ id: startA.id, result: { turn: turn('turn') } })
    await entered.promise
    const b = p.runtime.execute(second, { ...input, runId: 'other-run' }, async () => {})
    const startB = await p.request('turn/start')
    await p.send({ id: startB.id, result: { turn: turn('other-turn') } })
    await p.command({ action: 'raw', bytes: [...Buffer.from(`${JSON.stringify(delta())}\n`.repeat(1024))] })
    await p.request('turn/interrupt')
    gate.resolve()
    expect(await a).toMatchObject({ error: { code: 'STREAM_OVERFLOW' }, status: 'failed' })
    expect(await b).toMatchObject({ error: { code: 'PROCESS_EXITED' }, status: 'failed' })
  })

  test('preserves a received terminal result when the process exits during an awaited emit', async () => {
    const p = await peer()
    const session = await p.create()
    const gate = Promise.withResolvers<void>()
    const entered = Promise.withResolvers<void>()
    const execution = p.runtime.execute(session, input, async (notice) => {
      if (notice.kind === 'started') {
        entered.resolve()
        await gate.promise
      }
    })
    const start = await p.request('turn/start')
    await p.send({ id: start.id, result: { turn: turn('turn') } })
    await entered.promise
    await p.send(done())
    await p.exit()
    gate.resolve()
    expect(await execution).toEqual({ status: 'succeeded' })
  })

  test.each([
    ['completed', { status: 'succeeded' }],
    ['interrupted', { status: 'cancelled' }],
    ['failed', { error: { code: 'RUN_FAILED', message: 'Codex turn failed' }, status: 'failed' }]
  ])('preserves a terminal %s start response and queued output after transport exit', async (status, outcome) => {
    const p = await peer()
    const session = await p.create()
    const gate = Promise.withResolvers<void>()
    const entered = Promise.withResolvers<void>()
    const notices: AdapterNotice[] = []
    const execution = p.runtime.execute(session, input, async (notice) => {
      notices.push(notice)
      if (notice.kind === 'started') {
        entered.resolve()
        await gate.promise
      }
    })
    const start = await p.request('turn/start')
    await p.send(delta())
    await entered.promise
    await p.send({ id: start.id, result: { turn: turn('turn', status) } })
    await p.exit()
    gate.resolve()
    expect(await execution).toEqual(outcome)
    expect(notices).toEqual([
      { kind: 'started', nativeTurnId: 'turn' },
      { event: { messageId: 'run:message', role: 'assistant', type: 'TEXT_MESSAGE_START' }, kind: 'event' },
      { event: { delta: 'hello', messageId: 'run:message', type: 'TEXT_MESSAGE_CONTENT' }, kind: 'event' },
      { event: { messageId: 'run:message', type: 'TEXT_MESSAGE_END' }, kind: 'event' }
    ])
  })

  test('fails mismatched early and response identities and closes the uncertain transport', async () => {
    const p = await peer()
    const session = await p.create()
    const execution = p.runtime.execute(session, input, async () => {})
    const start = await p.request('turn/start')
    await p.send(done('native', 'early'))
    await p.send({ id: start.id, result: { turn: turn('actual') } })
    expect(await execution).toMatchObject({ error: { code: 'PROTOCOL_ERROR' }, status: 'failed' })
    await p.closed()
  })

  test('does not kill other sessions when ordinary cancellation times out', async () => {
    const p = await peer(60)
    const session = await p.create()
    const execution = p.runtime.execute(session, input, async () => {})
    const start = await p.request('turn/start')
    await p.send({ id: start.id, result: { turn: turn('turn') } })
    const cancellation = expect(p.runtime.cancel('run')).rejects.toMatchObject({ code: 'CANCEL_TIMEOUT' })
    await p.request('turn/interrupt')
    await cancellation
    const other = await p.create('other')
    expect(other.nativeSessionId).toBe('other')
    expect(p.connections()).toBe(1)
    await p.send(done('native', 'turn', 'interrupted'))
    expect(await execution).toEqual({ status: 'cancelled' })
  })

  test('awaits safe interruption after an emitter rejection', async () => {
    const p = await peer()
    const session = await p.create()
    const execution = p.runtime.execute(session, input, () => Promise.reject(new Error('storage failed')))
    const start = await p.request('turn/start')
    await p.send({ id: start.id, result: { turn: turn('turn') } })
    const interrupt = await p.request('turn/interrupt')
    await p.send({ id: interrupt.id, result: {} })
    await p.send(done('native', 'turn', 'interrupted'))
    expect(await execution).toMatchObject({ error: { code: 'ADAPTER_ERROR' }, status: 'failed' })
  })

  test('rejects a file as a working directory before startup', async () => {
    const p = await peer()
    await expect(p.runtime.createSession({ cwd: fakePath })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(p.connections()).toBe(0)
  })

  test('surfaces spawn failure and permanently rejects operations after disposal', async () => {
    const runtime = new CodexRuntime({ executable: { command: '/nonexistent/agent-runtime' }, model: 'test' })
    await expect(runtime.createSession({ cwd })).rejects.toMatchObject({ code: 'PROCESS_EXITED' })
    await runtime.dispose()
    await expect(runtime.createSession({ cwd })).rejects.toMatchObject({ code: 'DISPOSED' })
  })
  test('fails both sessions on process loss and executes an explicit run in a fresh process', async () => {
    const p = await peer()
    const first = await p.create('first')
    const second = await p.create('second')
    const one = p.runtime.execute(first, input, async () => {})
    const firstStart = await p.request('turn/start')
    await p.send({ id: firstStart.id, result: { turn: turn('turn-one') } })
    const two = p.runtime.execute(second, { ...input, runId: 'run-two' }, async () => {})
    const secondStart = await p.request('turn/start')
    await p.send({ id: secondStart.id, result: { turn: turn('turn-two') } })
    await p.exit()
    expect(await Promise.all([one, two])).toEqual([
      expect.objectContaining({ error: expect.objectContaining({ code: 'PROCESS_EXITED' }), status: 'failed' }),
      expect.objectContaining({ error: expect.objectContaining({ code: 'PROCESS_EXITED' }), status: 'failed' })
    ])
    const notices: AdapterNotice[] = []
    const next = p.runtime.execute(first, { ...input, runId: 'new-run' }, (notice) => {
      notices.push(notice)
      return Promise.resolve()
    })
    await p.handshake()
    const resume = await p.request('thread/resume')
    expect(resume.params.threadId).toBe('first')
    await p.send({ id: resume.id, result: { cwd, model: 'model-test', thread: { id: 'first' } } })
    const start = await p.request('turn/start')
    await p.send({ id: start.id, result: { turn: turn('new-turn') } })
    await p.send(delta('first', 'turn-one', 'stale'))
    await p.send(delta('first', 'new-turn', 'fresh'))
    await p.send(done('first', 'new-turn'))
    expect(await next).toEqual({ status: 'succeeded' })
    expect(notices.filter((notice) => notice.kind === 'event' && notice.event.type === 'TEXT_MESSAGE_CONTENT')).toEqual(
      [{ event: { delta: 'fresh', messageId: 'new-run:message', type: 'TEXT_MESSAGE_CONTENT' }, kind: 'event' }]
    )
    expect(p.connections()).toBe(2)
  })

  test('disposes during initialization without restarting an accepted control operation', async () => {
    const p = await peer()
    const creating = p.runtime.createSession({ cwd }).catch((error: unknown) => error)
    await p.request('initialize')
    await p.runtime.dispose()
    expect(await creating).toMatchObject({ code: 'PROCESS_EXITED' })
    await expect(p.runtime.createSession({ cwd })).rejects.toMatchObject({ code: 'DISPOSED' })
    expect(p.connections()).toBe(1)
  })

  test('reports process loss when disposal wins before native startup', async () => {
    const p = await peer()
    const execution = p.runtime.execute({ cwd, nativeSessionId: 'saved', options: {} }, input, async () => {})
    await p.runtime.dispose()
    expect(await execution).toMatchObject({ error: { code: 'PROCESS_EXITED' }, status: 'failed' })
    expect(p.connections()).toBe(0)
  })
  test('validates a directly executed saved session before starting a process', async () => {
    const p = await peer()
    const outcome = await p.runtime.execute(
      { cwd: fakePath, nativeSessionId: 'saved', options: {} },
      input,
      async () => {}
    )
    expect(outcome).toMatchObject({ error: { code: 'INVALID_INPUT' }, status: 'failed' })
    expect(p.connections()).toBe(0)
  })
})
