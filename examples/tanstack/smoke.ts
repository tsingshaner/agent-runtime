// biome-ignore-all lint/suspicious/noConsole: Explicit real smoke.
// biome-ignore-all lint/suspicious/noMisplacedAssertion: Standalone smoke assertions.
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CodexRuntime } from '@qingshaner/runtime-codex'

import { startServer } from '../../apps/server/src/index.ts'
import { RuntimeClient } from './client.ts'

if (process.env.RUN_TANSTACK_SMOKE !== '1' || !process.env.CODEX_MODEL) {
  throw new Error('Explicit RUN_TANSTACK_SMOKE=1 and CODEX_MODEL required')
}
const dir = await mkdtemp(join(tmpdir(), 'tanstack-smoke-'))
const server = await startServer({
  dataDir: join(dir, 'db'),
  runtimes: [new CodexRuntime({ dataDir: join(dir, 'codex') })]
})
const client = new RuntimeClient(server.url, server.token)
try {
  const project = await client.request<{ id: string }>('/projects', { name: 'TanStack smoke' })
  const session = await client.request<{ id: string }>('/sessions', {
    cwd: dir,
    model: process.env.CODEX_MODEL,
    projectId: project.id,
    runtime: 'codex'
  })
  const { runId } = await client.submit(session.id, 'Without tools, reply with exactly hello.')
  const types: string[] = []
  const result = await client.watch(runId, {
    onEvent: (event) => {
      types.push(event.type)
    },
    signal: AbortSignal.timeout(120000)
  })
  assert.equal(result.terminal.type, 'RUN_FINISHED')
  assert.equal(types[0], 'RUN_STARTED')
  assert.equal(types.filter((type) => type === 'RUN_FINISHED').length, 1)
  const text = result.messages
    .flatMap((message) => message.parts)
    .filter((part) => part.type === 'text')
    .map((part) => part.content)
    .join('')
  assert.match(text, /hello/i)
  const replay = await client.watch(runId)
  const stable = (messages: typeof result.messages) => messages.map(({ id, role, parts }) => ({ id, parts, role }))
  assert.deepEqual(stable(replay.messages), stable(result.messages))
  console.log(
    'VERIFIED: real Codex HTTP SSE through official TanStack adapter/processor, ordered text, unique terminal, GET replay'
  )
  console.log(
    'UNVERIFIED: real tool/approval/input/cancellation and network drop not triggered; controlled HTTP tests cover them'
  )
} finally {
  await server.close()
  await rm(dir, { force: true, recursive: true })
}
