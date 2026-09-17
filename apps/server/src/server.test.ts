import { mkdtemp, rm } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as v from 'valibot'
import { afterEach, expect, test } from 'vitest'

import { ManualAdapter } from '../../../packages/runtime/test/manual-adapter'
import { startServer } from './index'

let cleanup = async () => {}
afterEach(async () => cleanup())

test('authenticates HTTP clients and replays durable SSE without resubmitting a run', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'runtime-http-'))
  const adapter = new ManualAdapter()
  const server = await startServer({ dataDir: directory, runtimes: [adapter] })
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
      v.parse(
        v.looseObject({ id: v.optional(v.string()), runId: v.optional(v.string()), status: v.optional(v.string()) }),
        value
      )
    )
  const session = await (
    await request('/sessions', 'POST', { cwd: directory, model: 'test', projectId: project.id, runtime: 'manual' })
  )
    .json()
    .then((value) =>
      v.parse(
        v.looseObject({ id: v.optional(v.string()), runId: v.optional(v.string()), status: v.optional(v.string()) }),
        value
      )
    )
  const run = await (await request(`/sessions/${session.id}/runs`, 'POST', { requestId: 'once', text: 'hello' }))
    .json()
    .then((value) =>
      v.parse(
        v.looseObject({ id: v.optional(v.string()), runId: v.optional(v.string()), status: v.optional(v.string()) }),
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
  expect(new TextDecoder().decode((await reader.read()).value)).toContain('RUN_STARTED')
  await reader.cancel()
  expect(
    await (await request(`/sessions/${session.id}/runs`, 'POST', { requestId: 'once', text: 'hello' })).json()
  ).toEqual(run)
  await adapter.push(run.runId, {
    kind: 'input',
    request: { nativeRequestId: 1, questions: [{ header: 'Q', id: 'q', question: 'Answer?' }] }
  })
  const [input] = v.parse(
    v.array(v.object({ id: v.string() })),
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
  const [approval] = v.parse(
    v.array(v.object({ id: v.string() })),
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
  await expect(fetch(`${server.url}/health`)).rejects.toThrow()
}, 20000)

test('rejects malformed requests and keeps subscribers independent during shutdown', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'runtime-http-security-'))
  const adapter = new ManualAdapter()
  const server = await startServer({ dataDir: directory, origins: ['http://localhost:3000'], runtimes: [adapter] })
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
  const wrongHost = await new Promise<number | undefined>((resolve, reject) => {
    const request = httpRequest(
      `${server.url}/health`,
      { headers: { ...headers, host: 'evil.example' } },
      (response) => {
        response.resume()
        resolve(response.statusCode)
      }
    )
    request.on('error', reject).end()
  })
  expect(wrongHost).toBe(403)
  const project = v.parse(v.object({ id: v.string() }), await (await send('/projects', { name: 'security' })).json())
  const session = v.parse(
    v.object({ id: v.string() }),
    await (await send('/sessions', { cwd: directory, model: 'test', projectId: project.id, runtime: 'manual' })).json()
  )
  const run = v.parse(
    v.object({ runId: v.string() }),
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
  const next = v.parse(
    v.object({ runId: v.string() }),
    await (await send(`/sessions/${session.id}/runs`, { text: 'cancel on shutdown' })).json()
  )
  await adapter.waitStarted(next.runId)
  await fetch(`${server.url}/runs/${next.runId}/events`, { headers })
  await Promise.all([server.close(), server.close()])
  const reopened = await startServer({ dataDir: directory, runtimes: [new ManualAdapter()] })
  await reopened.close()
}, 20000)
