import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { parseEvent } from '@qingshaner/runtime'
import { expect, test } from 'vitest'

import { startServer } from '../../apps/server/src/index'
import { ManualAdapter } from '../../packages/runtime/test/manual-adapter'
import { RuntimeClient } from './client'

test('official SSE client reconnects with GET, renders once, and answers durable interactions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tanstack-client-'))
  const adapter = new ManualAdapter()
  const server = await startServer({ dataDir: dir, runtimes: [adapter] })
  const requests: { method: string; cursor: string | null }[] = []
  let dropped = false
  const fetchClient: typeof fetch = async (url, init) => {
    const response = await fetch(url, init)
    requests.push({ cursor: new Headers(init?.headers).get('last-event-id'), method: init?.method ?? 'GET' })
    if (String(url).includes('/events') && !dropped) {
      dropped = true
      if (!response.body) {
        throw new Error('Missing response body')
      }
      const reader = response.body.getReader()
      return new Response(
        new ReadableStream({
          start: async (controller) => {
            controller.enqueue((await reader.read()).value)
            controller.close()
            await reader.cancel()
          }
        }),
        { headers: response.headers }
      )
    }
    return response
  }
  const client = new RuntimeClient(server.url, server.token, fetchClient)
  try {
    const project = await client.api.projects.create({ body: { name: 'test' } })
    const session = await client.api.sessions.create({
      body: {
        cwd: dir,
        model: 'test',
        projectId: project.id,
        runtime: 'manual'
      }
    })
    const { runId } = await client.submit(session.id, 'hello')
    await adapter.waitStarted(runId)
    const events: string[] = []
    let approvals = 0
    const watching = client.watch(runId, {
      approval: async () => (++approvals === 1 ? 'approve' : 'deny'),
      input: async () => ({ q: ['yes'] }),
      onEvent: (event) => {
        events.push(event.type)
      }
    })
    await expect.poll(() => requests.filter((request) => request.method === 'GET').length).toBeGreaterThan(0)
    for (const event of [
      { messageId: 'm', role: 'assistant', type: 'TEXT_MESSAGE_START' },
      { delta: 'hello', messageId: 'm', type: 'TEXT_MESSAGE_CONTENT' },
      { messageId: 'm', type: 'TEXT_MESSAGE_END' },
      { parentMessageId: 'm', toolCallId: 't', toolCallName: 'test', type: 'TOOL_CALL_START' },
      { delta: '{"x":1}', toolCallId: 't', type: 'TOOL_CALL_ARGS' },
      { toolCallId: 't', type: 'TOOL_CALL_END' },
      { content: 'ok', messageId: 'tool', role: 'tool', toolCallId: 't', type: 'TOOL_CALL_RESULT' }
    ]) {
      await adapter.push(runId, { event: parseEvent(event), kind: 'event' })
    }
    for (const nativeRequestId of [1, 2]) {
      await adapter.push(runId, {
        kind: 'approval',
        request: { allowedDecisions: ['approve', 'deny'], detail: {}, kind: 'command', nativeRequestId }
      })
      await expect.poll(() => adapter.decisions.length).toBe(nativeRequestId)
    }
    await adapter.push(runId, {
      kind: 'input',
      request: { nativeRequestId: 3, questions: [{ header: 'Q', id: 'q', question: 'Answer?' }] }
    })
    await expect.poll(() => adapter.answers.length).toBe(1)
    adapter.finish(runId, { status: 'succeeded' })
    const result = await watching
    expect(result.messages.flatMap((message) => message.parts).filter((part) => part.type === 'text')).toMatchObject([
      { content: 'hello' }
    ])
    expect(result.messages.flatMap((message) => message.parts).some((part) => part.type === 'tool-call')).toBe(true)
    expect(events[0]).toBe('RUN_STARTED')
    expect(events.at(-1)).toBe('RUN_FINISHED')
    expect(events.filter((event) => event === 'RUN_FINISHED')).toHaveLength(1)
    expect(events.filter((event) => event === 'TEXT_MESSAGE_CONTENT')).toHaveLength(1)
    expect(requests.some((request) => request.method === 'GET' && request.cursor !== null)).toBe(true)
    expect(adapter.executions.size).toBe(1)
    expect(adapter.decisions.map((item) => item.decision)).toEqual(['approve', 'deny'])
    expect(adapter.answers[0]?.answers).toEqual({ q: ['yes'] })
    const next = await client.submit(session.id, 'cancel')
    await adapter.waitStarted(next.runId)
    const pending = Promise.withResolvers<void>()
    const answer = Promise.withResolvers<'approve'>()
    let interactionSignal: AbortSignal | undefined
    const cancelled = client.watch(next.runId, {
      approval: (_request, signal) => {
        interactionSignal = signal
        pending.resolve()
        return answer.promise
      }
    })
    await adapter.push(next.runId, {
      kind: 'approval',
      request: { allowedDecisions: ['approve', 'deny'], detail: {}, kind: 'command', nativeRequestId: 4 }
    })
    await pending.promise
    await client.cancel(next.runId)
    expect((await cancelled).terminal.type).toBe('RUN_ERROR')
    expect(adapter.cancelled).toEqual([next.runId])
    expect(interactionSignal?.aborted).toBe(true)
    answer.resolve('approve')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(adapter.decisions).toHaveLength(2)
  } finally {
    await server.close()
    await rm(dir, { force: true, recursive: true })
  }
}, 30000)

test('surfaces an oRPC stream error without retrying or inventing a Run terminal', async () => {
  let requests = 0
  const events: string[] = []
  const client = new RuntimeClient('http://127.0.0.1:4310', 'test', () => {
    requests++
    return Promise.resolve(
      new Response(
        [
          'id: 1\nevent: message\ndata: {"type":"RUN_STARTED","threadId":"session","runId":"run"}\n\n',
          'event: error\ndata: {"defined":true,"code":"INTERNAL_SERVER_ERROR","message":"Internal error"}\n\n'
        ].join(''),
        { headers: { 'content-type': 'text/event-stream' } }
      )
    )
  })
  await expect(client.watch('run', { onEvent: (event) => events.push(event.type) })).rejects.toMatchObject({
    code: 'INTERNAL_SERVER_ERROR'
  })
  expect(events).toEqual(['RUN_STARTED'])
  expect(requests).toBe(1)
})

test('decodes an event subscription HTTP error as an oRPC error', async () => {
  const client = new RuntimeClient('http://127.0.0.1:4310', 'test', async () =>
    Response.json({ code: 'GONE', defined: true, message: 'Event history cleared' }, { status: 410 })
  )
  await expect(client.watch('run')).rejects.toMatchObject({ code: 'GONE' })
})
