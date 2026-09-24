import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

import { CodexRuntime } from '@qingshaner/runtime-codex'
// biome-ignore lint/correctness/noUndeclaredDependencies: Test helper uses the workspace Vitest dependency.
import { vi } from 'vitest'

import type { Json } from '@qingshaner/runtime'

import { JsonRpcClient } from '../src/client'

export const fakePath = fileURLToPath(new URL('./fake-app-server.mjs', import.meta.url))
export const cwd = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
const cleanup: (() => Promise<void>)[] = []
export const closePeers = async () => {
  for (const close of cleanup.splice(0).reverse()) {
    await close()
  }
}
type WireFrame = { id: number | string; method: string; params: Record<string, Json>; result?: Json }
type Control = { event: string; frame: WireFrame }

export const peer = async (requestTimeoutMs = 1000, stateDir?: string) => {
  const exits = vi.spyOn(JsonRpcClient.prototype, 'onExit')
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
  const dataDir = stateDir ? join(stateDir, 'native') : await mkdtemp(join(tmpdir(), 'codex-peer-'))
  const runtime = new CodexRuntime({
    dataDir,
    executable: {
      args: [fakePath, '--control-port', String(address.port), ...(stateDir ? ['--state-dir', stateDir] : [])],
      command: process.execPath
    },
    model: 'model-test',
    requestTimeoutMs,
    shutdownTimeoutMs: 30
  })
  cleanup.push(async () => {
    exits.mockRestore()
    await runtime.dispose()
    socket?.destroy()
    if (!stateDir) {
      await rm(dataDir, { force: true, recursive: true })
    }
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
    // biome-ignore lint/suspicious/noMisplacedAssertion: Awaited protocol peer invariant.
    assert.equal(frame.method, method)
    return frame
  }
  const handshake = async () => {
    await next('ready')
    const frame = await request('initialize')
    // biome-ignore lint/suspicious/noMisplacedAssertion: Awaited protocol peer invariant.
    assert.deepEqual(frame.params, {
      capabilities: null,
      clientInfo: { name: 'agent-runtime', title: null, version: '0.0.0' }
    })
    await send({
      id: frame.id,
      result: { codexHome: '/tmp', platformFamily: 'unix', platformOs: 'macos', userAgent: 'test' }
    })
    const initialized = await request('initialized')
    // biome-ignore lint/suspicious/noMisplacedAssertion: Awaited protocol peer invariant.
    assert.equal(Object.hasOwn(initialized, 'id'), false)
  }
  const create = async (id = 'native', projectId?: string) => {
    const pending = runtime.createSession({ cwd, projectId })
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
    exit: async () => {
      // Observe real transport completion; socket close can precede its exit listener.
      const client = exits.mock.contexts.at(-1) as JsonRpcClient | undefined
      if (!client) {
        throw new Error('Missing transport')
      }
      const exited = new Promise<void>((resolve) => client.onExit(() => resolve()))
      await command({ action: 'exit' })
      await exited
    },
    handshake,
    request,
    runtime,
    send
  }
}
export const turn = (id: string, status = 'inProgress') => ({ error: null, id, status })
export const done = (threadId = 'native', id = 'turn', status = 'completed') => ({
  method: 'turn/completed',
  params: { threadId, turn: turn(id, status) }
})
export const delta = (threadId = 'native', turnId = 'turn', text = 'hello') => ({
  method: 'item/agentMessage/delta',
  params: { delta: text, itemId: 'message', threadId, turnId }
})
export const input = { runId: 'run', sessionId: 'session', text: 'hello' }
