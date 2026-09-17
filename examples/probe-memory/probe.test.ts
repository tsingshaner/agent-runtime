// biome-ignore-all lint/style/useNamingConvention: Verify the official SDK wire protocol.
// biome-ignore-all lint/suspicious/noMisplacedAssertion: Vitest conditional test.
import { createServer } from 'node:http'

import { expect, test } from 'vitest'

import { projectClient, writeOnce } from './probe.ts'

test('a lost write response remains unknown and is never resent', async () => {
  const bodies: unknown[] = []
  const server = createServer(async (request) => {
    const chunks = []
    for await (const chunk of request) {
      chunks.push(chunk)
    }
    bodies.push(JSON.parse(Buffer.concat(chunks).toString()))
    request.socket.destroy()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    if (!address || typeof address === 'string') {
      throw new Error('Missing server address')
    }
    const client = projectClient(`http://127.0.0.1:${address.port}`, 'project-a', 'codex-session')
    const result = await writeOnce(client, 'run-1', 'Hello', 'World')
    expect(result).toMatchObject({ runId: 'run-1', status: 'unknown' })
    expect(bodies).toEqual([
      {
        agent_id: 'agent-runtime',
        messages: [
          { content: 'Hello', id: 'run-1:user', role: 'user' },
          { content: 'World', id: 'run-1:assistant', role: 'assistant' }
        ],
        session_id: 'codex-session',
        team_id: 'project-a',
        user_id: 'local-user'
      }
    ])
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  }
})

test.skipIf(!process.env.MEMORY_CORE_DIR)(
  'fixed real Gateway preserves data and isolates project profiles',
  async () => {
    const { probeGateway } = await import('./gateway.ts')
    const result = await probeGateway(process.env.MEMORY_CORE_DIR ?? '')
    expect(result).toMatchObject({ duplicateIds: 'NOT_IDEMPOTENT', l0: 'PASS', profiles: 'PASS', restart: 'PASS' })
  },
  120000
)
