import { once } from 'node:events'
import { createServer, type Socket } from 'node:net'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { afterEach, describe, expect, test } from 'vitest'

import { JsonRpcClient } from './client'

import type { Frame } from './protocol'

const fakePath = fileURLToPath(new URL('../test/fake-app-server.mjs', import.meta.url))
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) {
    await close()
  }
})

interface ControlMessage {
  event: string
  pid: number
  frame: { id: number | string; method?: string; result?: unknown; error?: unknown; params?: unknown }
}

async function peer(requestTimeoutMs = 1000) {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Missing loopback address')
  }
  const connected = once(server, 'connection')
  const client = new JsonRpcClient({
    args: [fakePath, '--control-port', String(address.port)],
    command: process.execPath,
    requestTimeoutMs,
    shutdownTimeoutMs: 40
  })
  let socket: Socket | undefined
  cleanup.push(async () => {
    await client.close()
    socket?.destroy()
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  })
  ;[socket] = (await connected) as [Socket]
  const messages: ControlMessage[] = []
  const waiting: { event: string; resolve: (message: ControlMessage) => void }[] = []
  createInterface({ input: socket }).on('line', (line) => {
    const message = JSON.parse(line) as ControlMessage
    const index = waiting.findIndex((waiter) => waiter.event === message.event)
    const waiter = waiting.splice(index < 0 ? waiting.length : index, 1)[0]
    if (waiter) {
      waiter.resolve(message)
    } else {
      messages.push(message)
    }
  })
  const next = (event: string): Promise<ControlMessage> => {
    const index = messages.findIndex((message) => message.event === event)
    if (index >= 0) {
      const message = messages.splice(index, 1)[0]
      if (message) {
        return Promise.resolve(message)
      }
    }
    return new Promise((resolve) => waiting.push({ event, resolve }))
  }
  const ready = await next('ready')
  const command = async (value: unknown) => {
    socket?.write(`${JSON.stringify(value)}\n`)
    await next('ack')
  }
  return { client, command, next, pid: ready.pid, send: (frame: unknown) => command({ action: 'send', frame }) }
}

const delta = {
  method: 'item/agentMessage/delta',
  params: { delta: '你好🙂', itemId: 'item', threadId: 'thread', turnId: 'turn' }
}

describe('JsonRpcClient', () => {
  test('rejects pending requests when the process exits', async () => {
    const client = new JsonRpcClient({
      args: [fakePath, '--exit-on-request'],
      command: process.execPath,
      requestTimeoutMs: 1000
    })
    try {
      await expect(client.request('initialize', {})).rejects.toMatchObject({ code: 'PROCESS_EXITED' })
    } finally {
      await client.close()
    }
  })

  test('correlates out-of-order responses including id zero', async () => {
    const { client, next, send } = await peer()
    const first = client.request('first', {})
    const a = await next('received')
    const second = client.request('second', {})
    const b = await next('received')
    expect(a.frame.id).toBe(0)
    await send({ id: b.frame.id, result: 'second' })
    await send({ id: a.frame.id, result: 'first' })
    await expect(Promise.all([first, second])).resolves.toEqual(['first', 'second'])
  })

  test('keeps server request IDs separate from pending client IDs', async () => {
    const { client, next, send } = await peer()
    const frames: Frame[] = []
    client.onFrame((frame) => frames.push(frame))
    const result = client.request('work', {})
    const request = await next('received')
    await send({ id: request.frame.id, method: 'approval/unknown', params: {} })
    await send({ id: request.frame.id, result: 'done' })
    await expect(result).resolves.toBe('done')
    expect(frames[0]).toMatchObject({ id: 0, kind: 'server-request', method: 'approval/unknown' })
  })

  test.each([0, '0'])('preserves server reply ID %s', async (id) => {
    const { client, next } = await peer()
    await client.reply(id, { decision: 'accept' })
    expect((await next('received')).frame).toEqual({ id, result: { decision: 'accept' } })
    await client.replyError(id, -32601, 'Unsupported method')
    expect((await next('received')).frame).toEqual({ error: { code: -32601, message: 'Unsupported method' }, id })
  })

  test('sends handshake notifications without allocating a response waiter', async () => {
    const { client, next } = await peer()
    await client.notify('initialized', {})
    expect((await next('received')).frame).toEqual({ method: 'initialized', params: {} })
  })

  test('decodes UTF-8 split across byte boundaries', async () => {
    const { client, command } = await peer()
    const received = new Promise<Frame>((resolve) => client.onFrame(resolve))
    const bytes = Buffer.from(`${JSON.stringify(delta)}\n`)
    const split = bytes.indexOf(Buffer.from('你')) + 1
    await command({ action: 'raw', bytes: [...bytes.subarray(0, split)] })
    await command({ action: 'raw', bytes: [...bytes.subarray(split)] })
    await expect(received).resolves.toMatchObject({ kind: 'notification', ...delta })
  })

  test('ignores unknown response IDs without emitting frames', async () => {
    const { client, next, send } = await peer()
    const frames: Frame[] = []
    client.onFrame((frame) => frames.push(frame))
    const request = client.request('work', {})
    await next('received')
    await send({ id: '0', result: 'unrelated' })
    await send({ id: 900, result: 'unrelated' })
    await send({ id: 0, result: 'known' })
    await expect(request).resolves.toBe('known')
    expect(frames).toHaveLength(1)
  })

  test.each([
    '{bad}\n',
    '{"id":0}\n',
    '{"id":0,"result":1,"error":{"code":1,"message":"x"}}\n',
    '{"method":"item/agentMessage/delta","params":{"delta":9}}\n'
  ])('closes malformed protocol input %s', async (raw) => {
    const { client, next, command } = await peer()
    const request = client.request('work', {})
    const rejected = expect(request).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' })
    await next('received')
    await command({ action: 'raw', bytes: [...Buffer.from(raw)] })
    await rejected
    await client.close()
    await expect(client.request('later', {})).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' })
  })

  test('rejects a malformed known response at its native boundary', async () => {
    const { client, next, send } = await peer()
    const rejected = expect(client.request('thread/start', {})).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' })
    await next('received')
    await send({ id: 0, result: { thread: { id: 4 } } })
    await rejected
  })

  test('times out once and ignores a late response', async () => {
    const { client, next, send } = await peer(50)
    const frames: Frame[] = []
    client.onFrame((frame) => frames.push(frame))
    const rejected = expect(client.request('slow', {})).rejects.toMatchObject({ code: 'RPC_TIMEOUT' })
    await next('received')
    await rejected
    await send({ id: 0, result: 'late' })
    const result = client.request('next', {})
    expect((await next('received')).frame.method).toBe('next')
    await send({ id: 1, result: 'ok' })
    await expect(result).resolves.toBe('ok')
    expect(frames).toHaveLength(1)
  })

  test('keeps stderr and remote error secrets out of public errors', async () => {
    const { client, next, send, command } = await peer()
    const secret = 'sk-secret-do-not-leak'
    await command({ action: 'stderr', text: secret.repeat(3000) })
    const request = client.request('work', {})
    const rejected = expect(request).rejects.toMatchObject({ code: 'RPC_ERROR', message: 'RPC failed (code -32000)' })
    await next('received')
    await send({ error: { code: -32000, data: { secret }, message: secret }, id: 0 })
    await rejected
  })

  test('waits for backpressure before resolving an outgoing reply', async () => {
    const { client, command, next } = await peer()
    await command({ action: 'pause' })
    let sent = false
    const write = client.reply('large', 'x'.repeat(2 * 1024 * 1024)).then(() => {
      sent = true
    })
    await command({ action: 'stderr', text: 'barrier' })
    expect(sent).toBe(false)
    await command({ action: 'resume' })
    await write
    expect((await next('received')).frame.id).toBe('large')
  })

  test('rejects buffered small replies when the peer closes stdin before completion', async () => {
    const { client, command } = await peer()
    await command({ action: 'pause' })
    // Observe the real pipe only; no stream methods are replaced or production test APIs added.
    const { stdin } = Reflect.get(client, 'child') as ChildProcessWithoutNullStreams
    const replies: Promise<{ status: string; code?: string }>[] = []
    let resolvedWhileBuffered = false
    for (let batch = 0; batch < 16 && stdin.writableLength === 0; batch++) {
      for (let index = 0; index < 30; index++) {
        replies.push(
          client.reply(replies.length, 'x'.repeat(16_000)).then(
            () => {
              resolvedWhileBuffered ||= stdin.writableLength > 0
              return { status: 'fulfilled' }
            },
            (error: { code: string }) => ({ code: error.code, status: 'rejected' })
          )
        )
      }
      await command({ action: 'stderr', text: 'barrier' })
    }
    expect(stdin.writableLength).toBeGreaterThan(0)

    await command({ action: 'close-input' })
    const results = await Promise.all(replies)

    expect(results.filter((result) => result.status === 'rejected').length).toBeGreaterThan(0)
    expect(
      results.filter((result) => result.status === 'rejected').every((result) => result.code === 'PROCESS_EXITED')
    ).toBe(true)
    expect(resolvedWhileBuffered).toBe(false)
  })

  test.each([16, 2 * 1024 * 1024])('rejects %s-byte writes after the child closes stdin', async (size) => {
    const { client, command } = await peer()
    await command({ action: 'close-input' })
    await expect(client.reply(0, 'x'.repeat(size))).rejects.toMatchObject({ code: 'PROCESS_EXITED' })
  })

  test('rejects all requests when an unterminated frame exceeds 8 MiB', async () => {
    const { client, next, command } = await peer()
    const first = expect(client.request('one', {})).rejects.toMatchObject({ code: 'STREAM_OVERFLOW' })
    const second = expect(client.request('two', {})).rejects.toMatchObject({ code: 'STREAM_OVERFLOW' })
    await next('received')
    await next('received')
    await command({ action: 'repeat', count: 8 * 1024 * 1024 + 1, text: 'x' })
    await Promise.all([first, second])
  })

  test('removes listeners through the returned disposer', async () => {
    const { client, send, next } = await peer()
    const frames: Frame[] = []
    client.onFrame((frame) => frames.push(frame))()
    client.onExit(() => {
      throw new Error('removed exit listener')
    })()
    const request = client.request('barrier', {})
    await next('received')
    await send(delta)
    await send({ id: 0, result: null })
    await request
    expect(frames).toEqual([])
  })

  test('closes idempotently and waits for a stubborn child to actually exit', async () => {
    const { client, pid, command, next } = await peer()
    await command({ action: 'stubborn' })
    const pending = expect(client.request('work', {})).rejects.toMatchObject({ code: 'PROCESS_EXITED' })
    await next('received')
    let exits = 0
    client.onExit(() => {
      exits++
    })
    const close = client.close()
    expect(client.close()).toBe(close)
    await Promise.all([close, pending])
    expect(exits).toBe(1)
    expect(() => process.kill(pid, 0)).toThrow()
  })

  test('reports spawn failure and closes without hanging', async () => {
    const client = new JsonRpcClient({ args: [], command: '/nonexistent/agent-runtime-app-server' })
    try {
      await expect(client.request('initialize', {})).rejects.toMatchObject({ code: 'PROCESS_EXITED' })
    } finally {
      await client.close()
    }
  })
})
