// biome-ignore-all lint/suspicious/noConsole: Explicit smoke report.
// biome-ignore-all lint/suspicious/noMisplacedAssertion: Standalone assertions.
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { launchNitro } from './test/nitro.fixture.ts'

if (process.env.RUN_CODEX_SMOKE !== '1' || !process.env.CODEX_MODEL) {
  console.log('SKIPPED: set RUN_CODEX_SMOKE=1 and CODEX_MODEL for real HTTP/Codex smoke')
} else {
  const directory = await mkdtemp(join(tmpdir(), 'http-codex-smoke-'))
  const server = await launchNitro(join(directory, 'data'))
  const request = async (path: string, body?: unknown) => {
    const response = await fetch(`${server.url}${path}`, {
      headers: { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' },
      method: body ? 'POST' : 'GET',
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(120000)
    })
    assert.equal(response.status, 200)
    return response
  }
  try {
    const project = (await (await request('/projects', { name: 'Smoke' })).json()) as { id: string }
    const session = (await (
      await request('/sessions', {
        cwd: directory,
        model: process.env.CODEX_MODEL,
        projectId: project.id,
        runtime: 'codex'
      })
    ).json()) as { id: string }
    const run = (await (
      await request(`/sessions/${session.id}/runs`, {
        requestId: 'smoke',
        text: 'Without tools, reply with the word hello.'
      })
    ).json()) as { runId: string }
    const events = await (await request(`/runs/${run.runId}/events`)).text()
    const state = (await (await request(`/runs/${run.runId}`)).json()) as { status: string }
    assert.equal(state.status, 'succeeded')
    assert.equal(events.split('RUN_FINISHED').length, 2)
    const replay = await (await request(`/runs/${run.runId}/events?afterSequence=1`)).text()
    assert.ok(!replay.includes('RUN_STARTED'))
    console.log('VERIFIED: real Codex submission, text SSE, unique success and persisted cursor replay')
    console.log('UNVERIFIED: native approvals, input and cancellation were not triggered by this smoke')
  } finally {
    await server.close()
    await rm(directory, { force: true, recursive: true })
  }
}
