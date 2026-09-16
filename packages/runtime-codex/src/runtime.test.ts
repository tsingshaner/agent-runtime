import { once } from 'node:events'
import { createServer, type Socket } from 'node:net'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, test } from 'vitest'

import type { AdapterNotice, Json, JsonObject, NativeSession } from '@qingshaner/runtime'

import { CodexRuntime } from './runtime'

const fakePath = fileURLToPath(new URL('../test/fake-app-server.mjs', import.meta.url))
const cwd = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) {
    await close()
  }
})
type WireFrame = { id: number | string; method: string; params: Record<string, Json>; result?: Json }
type Control = { event: string; frame: WireFrame }

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function peer(requestTimeoutMs = 1000) {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Missing loopback address')
  }
  let connections = 0
  let socket: Socket | undefined
  const messages: Control[] = []
  const waiting: { event: string; resolve: (message: Control) => void }[] = []
  server.on('connection', (connected: Socket) => {
    connections++
    socket = connected
    createInterface({ input: socket }).on('line', (line) => {
      const message = JSON.parse(line) as Control
      const index = waiting.findIndex((waiter) => waiter.event === message.event)
      const waiter = waiting.splice(index < 0 ? waiting.length : index, 1)[0]
      if (waiter) {
        waiter.resolve(message)
      } else {
        messages.push(message)
      }
    })
  })
  const next = (event: string): Promise<Control> => {
    const index = messages.findIndex((message) => message.event === event)
    if (index >= 0) {
      const message = messages.splice(index, 1)[0]
      if (message) {
        return Promise.resolve(message)
      }
    }
    return new Promise((resolve) => waiting.push({ event, resolve }))
  }
  const runtime = new CodexRuntime({
    executable: { args: [fakePath, '--control-port', String(address.port)], command: process.execPath },
    model: 'model-test',
    requestTimeoutMs,
    shutdownTimeoutMs: 30
  })
  cleanup.push(async () => {
    await runtime.dispose()
    socket?.destroy()
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  })
  const command = async (value: { action: string; [key: string]: unknown }) => {
    if (!socket) {
      throw new Error('Peer has not connected')
    }
    socket.write(`${JSON.stringify(value)}\n`)
    if (value.action !== 'exit') {
      await next('ack')
    }
  }
  const send = (frame: unknown) => command({ action: 'send', frame })
  const request = async (method?: string) => {
    const { frame } = await next('received')
    // biome-ignore lint/suspicious/noMisplacedAssertion: Awaited peer assertion helper.
    expect(frame.method).toBe(method)
    return frame
  }
  const handshake = async () => {
    await next('ready')
    const frame = await request('initialize')
    // biome-ignore lint/suspicious/noMisplacedAssertion: Awaited handshake assertion helper.
    expect(frame.params).toEqual({
      capabilities: null,
      clientInfo: { name: 'agent-runtime', title: null, version: '0.0.0' }
    })
    await send({
      id: frame.id,
      result: { codexHome: '/tmp', platformFamily: 'unix', platformOs: 'macos', userAgent: 'test' }
    })
    const initialized = await request('initialized')
    // biome-ignore lint/suspicious/noMisplacedAssertion: Awaited handshake assertion helper.
    expect(initialized).not.toHaveProperty('id')
  }
  const create = async (id = 'native') => {
    const pending = runtime.createSession({ cwd })
    if (connections === 0) {
      await handshake()
    }
    const frame = await request('thread/start')
    await send({ id: frame.id, result: { cwd, model: 'model-test', thread: { id } } })
    return pending
  }
  return {
    closed: async () => {
      if (socket && !socket.destroyed) {
        await once(socket, 'close')
      }
    },
    command,
    connections: () => connections,
    create,
    handshake,
    request,
    runtime,
    send
  }
}
const turn = (id: string, status = 'inProgress') => ({ error: null, id, status })
const done = (threadId = 'native', id = 'turn', status = 'completed') => ({
  method: 'turn/completed',
  params: { threadId, turn: turn(id, status) }
})
const delta = (threadId = 'native', turnId = 'turn', text = 'hello') => ({
  method: 'item/agentMessage/delta',
  params: { delta: text, itemId: 'message', threadId, turnId }
})
const input = { runId: 'run', sessionId: 'session', text: 'hello' }

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
    const gate = deferred()
    const entered = deferred()
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
    await p.runtime.cancel('run')
    await p.runtime.cancel('run')
    await p.send({ id: start.id, result: { turn: turn('turn') } })
    const interrupt = await p.request('turn/interrupt')
    expect(interrupt.params).toEqual({ threadId: 'native', turnId: 'turn' })
    await p.send({ id: interrupt.id, result: {} })
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

  test.each(['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'])(
    'declines %s safely without an approval handler',
    async (method) => {
      const p = await peer()
      const session = await p.create()
      const execution = p.runtime.execute(session, input, async () => {})
      const start = await p.request('turn/start')
      await p.send({ id: start.id, result: { turn: turn('turn') } })
      await p.send({ id: 'approval', method, params: { itemId: 'tool', threadId: 'native', turnId: 'turn' } })
      const reply = await p.request()
      expect(reply).toEqual({ id: 'approval', result: { decision: 'decline' } })
      await p.send(done())
      expect(await execution).toEqual({ status: 'succeeded' })
    }
  )

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
      const gate = deferred()
      const entered = deferred()
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
    const gate = deferred()
    const entered = deferred()
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
    const gate = deferred()
    const entered = deferred()
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
    await p.command({ action: 'exit' })
    await p.closed()
    gate.resolve()
    expect(await execution).toEqual({ status: 'succeeded' })
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
    const cancellation = expect(p.runtime.cancel('run')).rejects.toMatchObject({ code: 'RPC_TIMEOUT' })
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
})
