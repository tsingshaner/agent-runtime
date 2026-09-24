// biome-ignore-all lint/suspicious/noConsole: Explicit native integration report.
// biome-ignore-all lint/suspicious/noMisplacedAssertion: Standalone smoke assertions.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { launchNitro } from './test/nitro.fixture.ts'

if (process.env.RUN_RUNTIME_SMOKE !== '1') {
  console.log('SKIPPED: set RUN_RUNTIME_SMOKE=1 for real three-runtime HTTP smoke')
} else {
  const entries = [
    ['codex', process.env.CODEX_MODEL],
    ['dsh', process.env.DSH_MODEL],
    ['deepagents', process.env.DEEPAGENTS_MODEL]
  ] as const
  assert(
    entries.every(([, model]) => model),
    'Set CODEX_MODEL, DSH_MODEL and DEEPAGENTS_MODEL'
  )
  const directory = await mkdtemp(join(tmpdir(), 'http-runtimes-'))
  let server = await launchNitro(join(directory, 'data'))
  const request = async (path: string, body?: unknown) => {
    const response = await fetch(`${server.url}${path}`, {
      headers: server.headers,
      method: body === undefined ? 'GET' : 'POST',
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(120000)
    })
    assert.equal(response.status, 200, `${path}: ${await response.clone().text()}`)
    return response
  }
  try {
    const sessions = await Promise.all(
      entries.map(async ([runtime, model]) => {
        const project = (await (await request('/projects', { name: runtime })).json()) as { id: string }
        const session = (await (
          await request('/sessions', { cwd: directory, model, projectId: project.id, runtime })
        ).json()) as { id: string; nativeSessionId: string }
        return { ...session, marker: `${runtime}-${randomUUID()}`, runtime }
      })
    )
    const runs = await Promise.all(
      sessions.map(async (session) => {
        const input = {
          requestId: 'first',
          text: `Remember this session marker: ${session.marker}. Reply hello without tools.`
        }
        const run = (await (await request(`/sessions/${session.id}/runs`, input)).json()) as { runId: string }
        assert.deepEqual(await (await request(`/sessions/${session.id}/runs`, input)).json(), run)
        const events = await (await request(`/runs/${run.runId}/events`)).text()
        assert.equal(events.split('RUN_FINISHED').length, 2)
        assert.equal(((await (await request(`/runs/${run.runId}`)).json()) as { status: string }).status, 'succeeded')
        return run
      })
    )
    await server.close()
    server = await launchNitro(join(directory, 'data'))
    await Promise.all(
      sessions.map(async (session, index) => {
        const prior = runs[index]
        assert(prior)
        assert.equal(((await (await request(`/runs/${prior.runId}`)).json()) as { status: string }).status, 'succeeded')
        const resumed = (await (await request(`/sessions/${session.id}/resume`, {})).json()) as {
          nativeSessionId: string
        }
        assert.equal(resumed.nativeSessionId, session.nativeSessionId)
        const next = (await (
          await request(`/sessions/${session.id}/runs`, {
            text: 'What exact session marker did I give you? Reply with it, without tools.'
          })
        ).json()) as { runId: string }
        const events = await (await request(`/runs/${next.runId}/events`)).text()
        assert.equal(events.split('RUN_FINISHED').length, 2)
        // Read decoded text deltas: a marker can be split across SSE frames.
        const deltas = [...events.matchAll(/"delta":"((?:[^"\\]|\\.)*)"/g)]
          .map((match) => JSON.parse(`"${match[1]}"`) as string)
          .join('')
        assert(deltas.includes(session.marker), `${session.runtime} did not retain native history`)
      })
    )
    console.log(
      'PASS: three actual runtimes concurrently through built HTTP, durable SSE/requestId, owned shutdown and cross-process native resume'
    )
    console.log(
      'UNVERIFIED in this scenario: native input/approval/cancel; use native-protocol-smoke and adapter checks'
    )
  } finally {
    await server.close()
    await rm(directory, { force: true, recursive: true })
  }
}
