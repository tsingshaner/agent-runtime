import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { RuntimeError } from '@qingshaner/runtime'
import { expect, test } from 'vitest'
import * as z from 'zod/mini'

import { ManualAdapter } from '../../../packages/runtime/test/manual-adapter'
import { openTestService } from '../test/service.fixture'

// Separate controllable protocol peers; actual native engines are covered by their adapter suites.
const controlledRuntime = (kind: string) => {
  const peer = new ManualAdapter()
  return {
    peer,
    runtime: {
      cancel: peer.cancel.bind(peer),
      createSession: peer.createSession.bind(peer),
      dispose: peer.dispose.bind(peer),
      execute: peer.execute.bind(peer),
      kind,
      respondApproval: peer.respondApproval.bind(peer),
      respondInput: peer.respondInput.bind(peer),
      resumeSession: peer.resumeSession.bind(peer)
    }
  }
}

test('isolates cancellation and process failure across runtimes while memory writes remain pending', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'runtime-http-multiple-'))
  const peers = [controlledRuntime('codex'), controlledRuntime('dsh'), controlledRuntime('deepagents')] as const
  const memoryWrite = Promise.withResolvers<{ status: 'accepted' }>()
  let server = await openTestService({
    dataDir: directory,
    memory: { recall: () => Promise.resolve({ context: '' }), write: () => memoryWrite.promise },
    runtimes: peers.map(({ runtime }) => runtime)
  })
  const request = (path: string, method = 'GET', body?: unknown) =>
    server.fetch(`${server.url}${path}`, {
      headers: { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' },
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    })
  const readId = async (response: Response) => {
    expect(response.status).toBe(200)
    return z.parse(z.object({ id: z.string() }), await response.json()).id
  }
  const readRun = async (response: Response) => {
    expect(response.status).toBe(200)
    return z.parse(z.object({ runId: z.string() }), await response.json()).runId
  }
  try {
    const sessions = []
    for (const { runtime } of peers) {
      const projectId = await readId(await request('/projects', 'POST', { name: runtime.kind }))
      sessions.push(
        await readId(
          await request('/sessions', 'POST', {
            cwd: directory,
            model: 'test',
            projectId,
            runtime: runtime.kind
          })
        )
      )
    }
    const invalid = await request('/sessions', 'POST', {
      cwd: directory,
      model: 'test',
      projectId: 'unused',
      runtime: 'private-secret'
    })
    expect(invalid.status).toBe(409)
    expect(await invalid.text()).not.toContain('private-secret')
    const runs = z.parse(
      z.tuple([z.string(), z.string(), z.string()]),
      await Promise.all(
        sessions.map(async (session) =>
          readRun(await request(`/sessions/${session}/runs`, 'POST', { text: 'parallel' }))
        )
      )
    )
    await Promise.all(
      peers.map(({ peer }, index) => {
        const run = runs[index]
        if (!run) {
          throw new Error('Missing run')
        }
        return peer.waitStarted(run)
      })
    )
    expect((await request(`/runs/${runs[0]}/cancel`, 'POST', {})).status).toBe(200)
    peers[1].peer.finish(runs[1], {
      error: { code: 'PROCESS_EXITED', message: 'Owned process exited' },
      status: 'interrupted'
    })
    peers[2].peer.finish(runs[2], { finalReply: 'completed independently', status: 'succeeded' })
    const events = await Promise.all(runs.map(async (run) => (await request(`/runs/${run}/events`)).text()))
    expect(events[0]?.match(/RUN_ERROR/g)).toHaveLength(1)
    expect(events[1]?.match(/RUN_ERROR/g)).toHaveLength(1)
    expect(events[2]?.match(/RUN_FINISHED/g)).toHaveLength(1)
    const states = await Promise.all(runs.map(async (run) => (await request(`/runs/${run}`)).json()))
    expect(states).toMatchObject([{ status: 'cancelled' }, { status: 'interrupted' }, { status: 'succeeded' }])
    expect(await (await request(`/runs/${runs[2]}/memory-write`)).json()).toMatchObject({
      error: { code: 'MEMORY_WRITE_UNCERTAIN' },
      status: 'unknown'
    })
    const waiting = await readRun(await request(`/sessions/${sessions[2]}/runs`, 'POST', { text: 'waiting input' }))
    await peers[2].peer.waitStarted(waiting)
    await peers[2].peer.push(waiting, {
      kind: 'input',
      request: { nativeRequestId: 'private-native', questions: [{ header: 'Q', id: 'q', question: 'Continue?' }] }
    })
    const inputs = await (await request(`/runs/${waiting}/inputs`)).json()
    const [input] = z.parse(z.array(z.object({ id: z.string() })), inputs)
    if (!input) {
      throw new Error('Missing pending input')
    }
    memoryWrite.resolve({ status: 'accepted' })
    await Promise.all([server.close(), server.close()])
    expect((await request('/health')).status).toBe(503)
    const reopened = peers.map(({ runtime }) => controlledRuntime(runtime.kind).runtime)
    const unsafe = reopened.find((runtime) => runtime.kind === 'deepagents')
    if (!unsafe) {
      throw new Error('Missing runtime')
    }
    unsafe.resumeSession = () => Promise.reject(new RuntimeError('UNSAFE_RESUME', 'Private checkpoint diagnostic'))
    server = await openTestService({ dataDir: directory, runtimes: reopened })
    const resume = await request(`/sessions/${sessions[2]}/resume`, 'POST', {})
    expect(resume.status).toBe(409)
    const rejection = await resume.text()
    expect(rejection).not.toContain('Private checkpoint diagnostic')
    expect(JSON.parse(rejection)).toMatchObject({ data: { code: 'UNSAFE_RESUME' } })
    const history = z.parse(
      z.object({ items: z.array(z.unknown()) }),
      await (await request(`/sessions/${sessions[2]}/runs`)).json()
    )
    expect(history.items).toHaveLength(2)
    const persisted = await Promise.all(runs.map(async (run) => (await request(`/runs/${run}`)).json()))
    expect(persisted).toMatchObject([{ status: 'cancelled' }, { status: 'interrupted' }, { status: 'succeeded' }])
    expect(await (await request(`/runs/${waiting}/inputs`)).json()).toEqual([])
    expect((await request(`/runs/${waiting}/inputs/${input.id}`, 'POST', { answers: { q: ['yes'] } })).status).toBe(409)
  } finally {
    memoryWrite.resolve({ status: 'accepted' })
    await server.close()
    await rm(directory, { force: true, recursive: true })
  }
}, 20000)
