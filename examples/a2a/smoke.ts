// biome-ignore-all lint/suspicious/noMisplacedAssertion: Standalone built-server smoke.
// biome-ignore-all lint/suspicious/noConsole: Smoke reports no credentials.
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ClientFactory, DefaultAgentCardResolver, JsonRpcTransportFactory } from '@a2a-js/sdk/client'

import { launchNitro } from '../../apps/server/test/nitro.fixture.ts'

const directory = await mkdtemp(join(tmpdir(), 'a2a-nitro-'))
try {
  const server = await launchNitro(directory)
  try {
    const fetchImpl: typeof fetch = (input, init) => {
      const request = new Request(input, init)
      request.headers.set('authorization', `Bearer ${server.token}`)
      return fetch(request)
    }
    assert.equal((await fetch(`${server.url}/.well-known/agent-card.json`)).status, 401)
    const client = await new ClientFactory({
      cardResolver: new DefaultAgentCardResolver({ fetchImpl }),
      transports: [new JsonRpcTransportFactory({ fetchImpl })]
    }).createFromUrl(server.url)
    await assert.rejects(client.getTask({ id: 'missing', tenant: '' }), { name: 'TaskNotFoundError' })
    await assert.rejects(
      client.resubscribeTask({ id: 'missing', tenant: '' }).next(),
      (error: unknown) =>
        error instanceof Error &&
        error.cause instanceof Error &&
        'reason' in error.cause &&
        error.cause.reason === 'TASK_NOT_FOUND'
    )
    console.log(
      'VERIFIED: built Nitro discovery, authentication, official A2A JSON-RPC client and SSE errors; no model calls.'
    )
    console.log(
      'UNVERIFIED: live model execution, native input, approval and cancellation. Run the interactive example explicitly.'
    )
  } finally {
    await server.close()
  }
} finally {
  await rm(directory, { force: true, recursive: true })
}
