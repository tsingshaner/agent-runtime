import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, expect, test } from 'vitest'
import * as z from 'zod/mini'

import { ManualAdapter } from '../../../packages/runtime/test/manual-adapter'
import { openTestService } from '../test/service.fixture'

let cleanup = async () => {}
afterEach(async () => cleanup())

test('authenticates HTTP clients and replays durable SSE without resubmitting a run', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'runtime-http-'))
  const adapter = new ManualAdapter()
  const server = await openTestService({ dataDir: directory, runtimes: [adapter] })
  const fetch = server.fetch
  cleanup = async () => {
    await server.close()
    await rm(directory, { force: true, recursive: true })
  }
  const request = (path: string, method = 'GET', body?: unknown) =>
    fetch(`${server.url}${path}`, {
      headers: { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' },
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    })
  expect((await fetch(`${server.url}/health`)).status).toBe(401)
  expect(
    (
      await fetch(`${server.url}/health`, {
        headers: { authorization: `Bearer ${server.token}`, origin: 'https://evil.example' }
      })
    ).status
  ).toBe(403)
  expect((await request('/health')).status).toBe(200)
  const project = await (await request('/projects', 'POST', { name: 'HTTP' }))
    .json()
    .then((value) =>
      z.parse(
        z.looseObject({ id: z.optional(z.string()), runId: z.optional(z.string()), status: z.optional(z.string()) }),
        value
      )
    )
  const session = await (
    await request('/sessions', 'POST', { cwd: directory, model: 'test', projectId: project.id, runtime: 'manual' })
  )
    .json()
    .then((value) =>
      z.parse(
        z.looseObject({ id: z.optional(z.string()), runId: z.optional(z.string()), status: z.optional(z.string()) }),
        value
      )
    )
  const run = await (await request(`/sessions/${session.id}/runs`, 'POST', { requestId: 'once', text: 'hello' }))
    .json()
    .then((value) =>
      z.parse(
        z.looseObject({ id: z.optional(z.string()), runId: z.optional(z.string()), status: z.optional(z.string()) }),
        value
      )
    )
  if (!run.runId) {
    throw new Error('Missing run')
  }
  await adapter.waitStarted(run.runId)
  const stream = await request(`/runs/${run.runId}/events`)
  if (!stream.body) {
    throw new Error('Missing stream')
  }
  const reader = stream.body.getReader()
  let started = ''
  while (!started.includes('RUN_STARTED')) {
    const chunk = await reader.read()
    expect(chunk.done).toBe(false)
    started += new TextDecoder().decode(chunk.value)
  }
  await reader.cancel()
  expect(
    await (await request(`/sessions/${session.id}/runs`, 'POST', { requestId: 'once', text: 'hello' })).json()
  ).toEqual(run)
  await adapter.push(run.runId, {
    kind: 'input',
    request: { nativeRequestId: 1, questions: [{ header: 'Q', id: 'q', question: 'Answer?' }] }
  })
  const [input] = z.parse(
    z.array(z.object({ id: z.string() })),
    await (await request(`/runs/${run.runId}/inputs`)).json()
  )
  if (!input) {
    throw new Error('Missing input')
  }
  expect((await request(`/runs/${run.runId}/inputs/${input.id}`, 'POST', { answers: { q: ['yes'] } })).status).toBe(200)
  await adapter.push(run.runId, {
    kind: 'approval',
    request: { allowedDecisions: ['approve', 'deny'], detail: {}, kind: 'command', nativeRequestId: 2 }
  })
  const [approval] = z.parse(
    z.array(z.object({ id: z.string() })),
    await (await request(`/runs/${run.runId}/approvals`)).json()
  )
  if (!approval) {
    throw new Error('Missing approval')
  }
  expect((await request(`/runs/${run.runId}/approvals/${approval.id}`, 'POST', { decision: 'deny' })).status).toBe(200)
  expect((await request(`/runs/${run.runId}/cancel`, 'POST', {})).status).toBe(200)
  const replay = await (await request(`/runs/${run.runId}/events?afterSequence=1`)).text()
  expect(replay).not.toContain('RUN_STARTED')
  expect(replay).toContain('RUN_ERROR')
  expect(await (await request(`/runs/${run.runId}`)).json()).toMatchObject({ status: 'cancelled' })
  expect((await request(`/runs/${run.runId}/events`, 'DELETE')).status).toBe(200)
  expect((await request(`/runs/${run.runId}/events`)).status).toBe(410)
  await server.close()
  expect((await request('/health')).status).toBe(503)
}, 20000)

test('rejects malformed requests and keeps subscribers independent during shutdown', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'runtime-http-security-'))
  const adapter = new ManualAdapter()
  const server = await openTestService({ dataDir: directory, origins: ['http://localhost:3000'], runtimes: [adapter] })
  const fetch = server.fetch
  cleanup = async () => {
    await server.close()
    await rm(directory, { force: true, recursive: true })
  }
  const headers = { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' }
  const send = (path: string, data: unknown) =>
    fetch(`${server.url}${path}`, { body: JSON.stringify(data), headers, method: 'POST' })
  const preflight = await fetch(`${server.url}/projects`, {
    headers: {
      'access-control-request-headers': 'authorization,content-type',
      'access-control-request-method': 'POST',
      origin: 'http://localhost:3000'
    },
    method: 'OPTIONS'
  })
  expect(preflight.status).toBe(204)
  expect(preflight.headers.get('access-control-allow-origin')).toBe('http://localhost:3000')
  expect((await fetch(`${server.url}/%GG`, { headers })).status).toBe(400)
  expect((await send('/projects', { extra: true, name: 'x' })).status).toBe(400)
  expect((await fetch(`${server.url}/projects`, { body: '{bad', headers, method: 'POST' })).status).toBe(400)
  expect((await fetch(`${server.url}/health`, { headers: { ...headers, host: 'evil.example' } })).status).toBe(403)
  const project = z.parse(z.object({ id: z.string() }), await (await send('/projects', { name: 'security' })).json())
  const session = z.parse(
    z.object({ id: z.string() }),
    await (await send('/sessions', { cwd: directory, model: 'test', projectId: project.id, runtime: 'manual' })).json()
  )
  const run = z.parse(
    z.object({ runId: z.string() }),
    await (await send(`/sessions/${session.id}/runs`, { text: 'wait' })).json()
  )
  await adapter.waitStarted(run.runId)
  const endpoint = `${server.url}/runs/${run.runId}/events`
  expect((await fetch(`${endpoint}?afterSequence=-1`, { headers })).status).toBe(400)
  expect((await fetch(endpoint, { headers: { ...headers, 'last-event-id': '999' } })).status).toBe(400)
  const slow = await fetch(endpoint, { headers })
  const fast = await fetch(endpoint, { headers })
  adapter.finish(run.runId, { status: 'succeeded' })
  const events = await fast.text()
  expect(events.match(/RUN_FINISHED/g)).toHaveLength(1)
  expect(await slow.text()).toBe(events)
  const next = z.parse(
    z.object({ runId: z.string() }),
    await (await send(`/sessions/${session.id}/runs`, { text: 'cancel on shutdown' })).json()
  )
  await adapter.waitStarted(next.runId)
  await fetch(`${server.url}/runs/${next.runId}/events`, { headers })
  await Promise.all([server.close(), server.close()])
  const reopened = await openTestService({ dataDir: directory, runtimes: [new ManualAdapter()] })
  await reopened.close()
}, 20000)
