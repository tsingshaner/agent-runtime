import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SendMessageRequest, TaskState } from '@a2a-js/sdk'
import { ClientFactory, DefaultAgentCardResolver, JsonRpcTransportFactory } from '@a2a-js/sdk/client'
import { EventType } from '@ag-ui/core'
import { afterEach, describe, expect, test } from 'vitest'
import * as z from 'zod/mini'

import { openTestService } from '../../../apps/server/test/service.fixture'
import { ManualAdapter } from '../test/manual-adapter'
import { SessionStore } from './store'

let cleanup: (() => Promise<void>) | undefined
afterEach(async () => {
  await cleanup?.()
})

const setup = async () => {
  const directory = await mkdtemp(join(tmpdir(), 'runtime-a2a-'))
  const adapter = new ManualAdapter()
  let service = await openTestService({ dataDir: directory, runtimes: [adapter] })
  cleanup = async () => {
    await service.close()
    await rm(directory, { force: true, recursive: true })
  }
  const fetchImpl: typeof fetch = (input, init) => {
    const request = new Request(input, init)
    request.headers.set('authorization', `Bearer ${service.token}`)
    return service.fetch(request)
  }
  const post = async (path: string, body: unknown) =>
    (
      await fetchImpl(`${service.url}${path}`, {
        body: JSON.stringify(body),
        headers: { 'a2a-version': '1.0', 'content-type': 'application/json' },
        method: 'POST'
      })
    ).json()
  const project = z.parse(z.object({ id: z.string() }), await post('/projects', { name: 'A2A' }))
  const session = z.parse(
    z.object({ id: z.string() }),
    await post('/sessions', { cwd: directory, model: 'test', projectId: project.id, runtime: 'manual' })
  )
  const factory = new ClientFactory({
    cardResolver: new DefaultAgentCardResolver({ fetchImpl }),
    transports: [new JsonRpcTransportFactory({ fetchImpl })]
  })
  const client = await factory.createFromUrl(service.url)
  return {
    adapter,
    client,
    fetchImpl,
    post,
    reopen: async () => {
      await service.close()
      service = await openTestService({ dataDir: directory, runtimes: [new ManualAdapter()] })
    },
    session,
    url: service.url
  }
}

const message = (contextId: string, text: string, taskId?: string) =>
  SendMessageRequest.fromJSON({
    configuration: { returnImmediately: true },
    message: { contextId, messageId: randomUUID(), parts: [{ text }], role: 'ROLE_USER', taskId }
  })

describe('A2A protocol', () => {
  test('discovers the card and persists a distinct Task for the same managed Run', async () => {
    const { client, session, adapter, reopen } = await setup()
    const result = await client.sendMessage(message(session.id, 'hello'))
    expect(result).toMatchObject({ contextId: session.id })
    if (!('id' in result)) {
      throw new Error('Expected task')
    }
    const task = result
    const runId = task.metadata?.runId as string
    expect(task.id).not.toBe(runId)
    await adapter.waitStarted(runId)
    adapter.finish(runId, { status: 'succeeded' })
    await expect
      .poll(async () => (await client.getTask({ id: task.id, tenant: '' })).status?.state)
      .toBe(TaskState.TASK_STATE_COMPLETED)
    await reopen()
    expect(await client.getTask({ id: task.id, tenant: '' })).toMatchObject({
      id: task.id,
      metadata: { runId },
      status: { state: TaskState.TASK_STATE_COMPLETED }
    })
  }, 20000)
  test('streams a snapshot then new output, closes on completion and rejects terminal subscriptions', async () => {
    const { client, session, adapter, fetchImpl, url, reopen } = await setup()
    const stream = client.sendMessageStream(message(session.id, 'stream'))
    const first = await stream.next()
    expect(first.value?.payload?.$case).toBe('task')
    if (first.value?.payload?.$case !== 'task') {
      throw new Error('Expected task snapshot')
    }
    const task = first.value.payload.value
    const runId = task.metadata?.runId as string
    await adapter.waitStarted(runId)
    await adapter.push(runId, {
      event: { delta: 'hello', messageId: 'reply', type: EventType.TEXT_MESSAGE_CONTENT },
      kind: 'event'
    })
    const update = await stream.next()
    expect(update.value?.payload).toMatchObject({
      $case: 'artifactUpdate',
      value: { artifact: { artifactId: 'reply', parts: [{ content: { value: 'hello' } }] } }
    })
    const abort = new AbortController()
    const reconnected = client.resubscribeTask({ id: task.id, tenant: '' }, { signal: abort.signal })
    expect((await reconnected.next()).value?.payload).toMatchObject({
      $case: 'task',
      value: { artifacts: [{ parts: [{ content: { value: 'hello' } }] }] }
    })
    abort.abort()
    await reconnected.return()
    adapter.finish(runId, { status: 'succeeded' })
    const remaining = await Array.fromAsync(stream)
    expect(remaining.at(-1)?.payload).toMatchObject({
      $case: 'statusUpdate',
      value: { status: { state: TaskState.TASK_STATE_COMPLETED } }
    })
    expect(remaining.filter((event) => event.payload?.$case === 'artifactUpdate')).toHaveLength(0)
    await expect(client.resubscribeTask({ id: task.id, tenant: '' }).next()).rejects.toThrow()
    await expect(client.sendMessage(message(session.id, 'again', task.id))).rejects.toThrow()
    await fetchImpl(`${url}/runs/${runId}/events`, { method: 'DELETE' })
    await reopen()
    expect((await client.getTask({ id: task.id, tenant: '' })).artifacts).toMatchObject([
      { parts: [{ content: { value: 'hello' } }] }
    ])
  }, 20000)

  test('answers input and approval on the original Task and Run', async () => {
    const { client, session, adapter } = await setup()
    const task = await client.sendMessage(message(session.id, 'interact'))
    if (!('id' in task)) {
      throw new Error('Expected task')
    }
    const runId = task.metadata?.runId as string
    await adapter.waitStarted(runId)
    await adapter.push(runId, {
      kind: 'input',
      request: { nativeRequestId: 1, questions: [{ header: 'Choice', id: 'q', question: 'Which?' }] }
    })
    const waiting = await client.getTask({ id: task.id, tenant: '' })
    expect(waiting.status?.state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED)
    const part = waiting.status?.message?.parts[0]?.content
    if (part?.$case !== 'data') {
      throw new Error('Expected interaction data')
    }
    const inputId = part.value.inputs[0].id
    const answer = SendMessageRequest.fromJSON({
      configuration: { returnImmediately: true },
      message: {
        messageId: randomUUID(),
        parts: [{ data: { answers: { q: ['yes'] }, inputId } }],
        role: 'ROLE_USER',
        taskId: task.id
      }
    })
    expect(await client.sendMessage(answer)).toMatchObject({
      id: task.id,
      metadata: { runId },
      status: { state: TaskState.TASK_STATE_WORKING }
    })
    await expect(client.sendMessage(answer)).rejects.toThrow()
    expect(adapter.answers).toEqual([{ answers: { q: ['yes'] }, nativeRequestId: 1, runId }])
    await adapter.push(runId, {
      kind: 'approval',
      request: { allowedDecisions: ['approve', 'deny'], detail: { tool: 'write' }, kind: 'tool', nativeRequestId: 'a' }
    })
    const approvalPart = (await client.getTask({ id: task.id, tenant: '' })).status?.message?.parts[0]?.content
    if (approvalPart?.$case !== 'data') {
      throw new Error('Expected approval data')
    }
    const approve = SendMessageRequest.fromJSON({
      configuration: { returnImmediately: true },
      message: {
        contextId: 'wrong-session',
        messageId: randomUUID(),
        parts: [{ data: { approvalId: approvalPart.value.approvals[0].id, decision: 'deny' } }],
        role: 'ROLE_USER',
        taskId: task.id
      }
    })
    await expect(client.sendMessage(approve)).rejects.toThrow()
    if (!approve.message) {
      throw new Error('Missing message')
    }
    approve.message.contextId = session.id
    expect(await client.sendMessage(approve)).toMatchObject({ id: task.id, metadata: { runId } })
    expect(adapter.decisions).toEqual([{ decision: 'deny', nativeRequestId: 'a', runId }])
    adapter.finish(runId, { status: 'succeeded' })
  }, 20000)

  test('does not report cancellation before native confirmation', async () => {
    const { client, session, adapter } = await setup()
    const task = await client.sendMessage(message(session.id, 'cancel'))
    if (!('id' in task)) {
      throw new Error('Expected task')
    }
    const runId = task.metadata?.runId as string
    await adapter.waitStarted(runId)
    adapter.finishOnCancel = false
    const result = await client.cancelTask({ id: task.id, metadata: undefined, tenant: '' })
    expect(result.status?.state).toBe(TaskState.TASK_STATE_WORKING)
    expect(adapter.cancelled).toEqual([runId])
    adapter.finish(runId, { status: 'cancelled' })
    await expect
      .poll(async () => (await client.getTask({ id: task.id, tenant: '' })).status?.state)
      .toBe(TaskState.TASK_STATE_CANCELED)
    await expect(client.cancelTask({ id: task.id, metadata: undefined, tenant: '' })).rejects.toThrow()
  }, 20000)

  test('blocking send waits for input and request retries do not create another Run', async () => {
    const { client, session, adapter } = await setup()
    const request = message(session.id, 'wait for input')
    if (!request.configuration) {
      throw new Error('Missing configuration')
    }
    request.configuration.returnImmediately = false
    let settled = false
    const pending = client.sendMessage(request).then((result) => {
      settled = true
      return result
    })
    await expect.poll(() => adapter.executions.size).toBe(1)
    expect(settled).toBe(false)
    const runId = [...adapter.executions.keys()][0]
    if (!runId) {
      throw new Error('Missing run')
    }
    await adapter.push(runId, {
      kind: 'input',
      request: { nativeRequestId: 1, questions: [{ header: 'Input', id: 'q', question: 'Answer?' }] }
    })
    const task = await pending
    expect(task).toMatchObject({ status: { state: TaskState.TASK_STATE_INPUT_REQUIRED } })
    expect(await client.sendMessage(request)).toMatchObject({ id: 'id' in task ? task.id : '' })
    expect(adapter.executions.size).toBe(1)
  }, 20000)

  test('rejects malformed and unsupported messages before starting execution', async () => {
    const { session, post, adapter } = await setup()
    for (const invalid of [
      { role: 'ROLE_AGENT' },
      { messageId: 12 },
      { parts: [] },
      { parts: [{ text: 42 }] },
      { parts: [{ url: 'https://example.com/file' }] },
      { contextId: 12 }
    ]) {
      const response = await post('/a2a', {
        id: 1,
        jsonrpc: '2.0',
        method: 'SendMessage',
        params: {
          configuration: { returnImmediately: true },
          message: {
            contextId: session.id,
            messageId: randomUUID(),
            parts: [{ text: 'secret-value' }],
            role: 'ROLE_USER',
            ...invalid
          }
        }
      })
      expect(response).toHaveProperty('error')
      expect(JSON.stringify(response)).not.toContain('secret-value')
    }
    expect(adapter.executions.size).toBe(0)
  }, 20000)

  test('recovers an unfinished task as failed and rejects its stale interaction', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'a2a-recovery-'))
    // Seed the durable state left by an interrupted host, then observe through A2A only.
    const store = await SessionStore.open(directory)
    await store.insertSession({
      cwd: directory,
      id: 'session',
      nativeSessionId: 'native',
      options: {},
      projectId: 'project',
      runtime: 'manual',
      title: 'recovery'
    })
    await store.beginRun('session', 'run', { text: 'wait' }, 'task')
    await store.requestInput('run', { nativeRequestId: 1, questions: [{ header: 'Q', id: 'q', question: 'Answer?' }] })
    const [input] = await store.listPendingInputs('run')
    await store.close()
    const adapter = new ManualAdapter()
    const service = await openTestService({ dataDir: directory, runtimes: [adapter] })
    cleanup = async () => {
      await service.close()
      await rm(directory, { force: true, recursive: true })
    }
    const call = async (method: string, params: unknown) =>
      (
        await service.fetch(`${service.url}/a2a`, {
          body: JSON.stringify({ id: 1, jsonrpc: '2.0', method, params }),
          headers: {
            'a2a-version': '1.0',
            authorization: `Bearer ${service.token}`,
            'content-type': 'application/json'
          },
          method: 'POST'
        })
      ).json()
    expect(await call('GetTask', { id: 'task' })).toMatchObject({
      result: {
        id: 'task',
        metadata: { runId: 'run', runStatus: 'interrupted' },
        status: { state: 'TASK_STATE_FAILED' }
      }
    })
    expect(
      await call('SendMessage', {
        message: {
          messageId: 'answer',
          parts: [{ data: { answers: { q: ['yes'] }, inputId: input?.id } }],
          role: 'ROLE_USER',
          taskId: 'task'
        }
      })
    ).toHaveProperty('error')
    expect(adapter.executions.size).toBe(0)
    expect(adapter.answers).toEqual([])
  }, 20000)

  test('protects discovery and requests with the same HTTP credentials and origin checks', async () => {
    const { fetchImpl, url, session, adapter, post } = await setup()
    expect(
      (await fetchImpl(`${url}/.well-known/agent-card.json`, { headers: { origin: 'https://evil.example' } })).status
    ).toBe(403)
    expect((await fetchImpl(`${url}/a2a`, { headers: { host: 'evil.example' } })).status).toBe(403)
    const malformed = await fetchImpl(`${url}/a2a`, {
      body: '{secret-value',
      headers: { 'a2a-version': '1.0' },
      method: 'POST'
    })
    expect(await malformed.text()).not.toContain('secret-value')
    const oversized = await fetchImpl(`${url}/a2a`, { body: 'x'.repeat(1024 * 1024 + 1), method: 'POST' })
    expect(await oversized.json()).toHaveProperty('error')
    const badVersion = await fetchImpl(`${url}/a2a`, {
      body: JSON.stringify({
        id: 1,
        jsonrpc: '2.0',
        method: 'SendMessage',
        params: SendMessageRequest.toJSON(message(session.id, 'ignored'))
      }),
      headers: { 'a2a-version': '0.3' },
      method: 'POST'
    })
    expect(await badVersion.json()).toHaveProperty('error')
    expect(await post('/a2a', { id: 2, jsonrpc: '2.0', method: 'GetTask', params: { id: 'missing' } })).toMatchObject({
      error: { data: [{ reason: 'TASK_NOT_FOUND' }] }
    })
    expect(adapter.executions.size).toBe(0)
  }, 20000)
})
