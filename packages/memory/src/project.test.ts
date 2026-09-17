import { once } from 'node:events'
import { createServer } from 'node:http'

import { expect, test } from 'vitest'

import { ProjectMemory } from './project'

test('shares project identity across sessions, bounds recall and never retries uncertain writes', async () => {
  const requests: { path: string; body: Record<string, unknown> }[] = []
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = []
      for await (const chunk of request) {
        chunks.push(chunk)
      }
      const body = JSON.parse(Buffer.concat(chunks).toString())
      requests.push({ body, path: request.url ?? '' })
      if (request.url?.endsWith('/add')) {
        request.socket.destroy()
        return
      }
      const data = request.url?.includes('/atomic/search')
        ? {
            items: [
              { content: 'x'.repeat(100), id: 'one' },
              { content: 'hidden', id: 'two' }
            ]
          }
        : request.url?.includes('/core/read')
          ? { content: 'core' }
          : { entries: [{ path: 'scenario', summary: 'summary' }] }
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ code: 0, data }))
    })().catch(() => response.destroy())
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Missing address')
  }
  process.env.MEMORY_TEST_TOKEN = 'secret'
  const memory = new ProjectMemory({
    apiKeyEnv: 'MEMORY_TEST_TOKEN',
    endpoint: `http://127.0.0.1:${address.port}`,
    serviceId: 'test'
  })
  try {
    const result = await memory.write({ assistant: 'world', projectId: 'p', runId: 'r', sessionId: 's', user: 'hello' })
    expect(result).toMatchObject({ projectId: 'p', runId: 'r', sessionId: 's', status: 'unknown' })
    expect(requests.filter(({ path }) => path.endsWith('/add'))).toHaveLength(1)
    const recall = await memory.recall('p', 'hello', { limit: 1, maxChars: 20 })
    expect(recall.context.length).toBeLessThanOrEqual(20)
    expect(recall.context).not.toContain('hidden')
    expect(
      requests.every(
        ({ body }) => body.team_id === 'p' && body.agent_id === 'agent-runtime' && body.user_id === 'local-user'
      )
    ).toBe(true)
    expect(
      requests.filter(({ path }) => !path.endsWith('/add')).every(({ body }) => !Object.hasOwn(body, 'session_id'))
    ).toBe(true)
  } finally {
    delete process.env.MEMORY_TEST_TOKEN
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test('confirms accepted IDs and scopes all maintenance operations without leaking service errors', async () => {
  const requests: Record<string, unknown>[] = []
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = []
      for await (const chunk of request) {
        chunks.push(chunk)
      }
      const body = JSON.parse(Buffer.concat(chunks).toString())
      requests.push(body)
      const data = request.url?.endsWith('/add')
        ? { accepted_ids: ['server-user', 'server-assistant'], total_count: 2 }
        : { deleted_count: 1, items: [], total: 0 }
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify(body.query === 'fail' ? { code: 500, message: 'private-token' } : { code: 0, data }))
    })().catch(() => response.destroy())
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Missing address')
  }
  process.env.MEMORY_TEST_TOKEN = 'private-token'
  const memory = new ProjectMemory({
    apiKeyEnv: 'MEMORY_TEST_TOKEN',
    endpoint: `http://127.0.0.1:${address.port}`,
    serviceId: 'test'
  })
  try {
    expect(
      await memory.write({ assistant: 'reply', projectId: 'p', runId: 'r', sessionId: 's', user: 'user' })
    ).toEqual({
      acceptedIds: ['server-user', 'server-assistant'],
      projectId: 'p',
      runId: 'r',
      sessionId: 's',
      status: 'accepted'
    })
    await memory.query('p')
    await memory.search('p', 'query')
    await memory.update('p', 'id', 'revised')
    await memory.delete('p', ['id'])
    await memory.conversations('p')
    await memory.deleteConversations('p', ['server-user'])
    expect(requests.every((body) => body.team_id === 'p')).toBe(true)
    expect(requests[0]?.messages).toEqual([
      { content: 'user', id: 'r:user', role: 'user' },
      { content: 'reply', id: 'r:assistant', role: 'assistant' }
    ])
    await expect(memory.search('p', 'fail')).rejects.toMatchObject({
      code: 'MEMORY_UNAVAILABLE',
      message: 'Memory service request failed'
    })
    delete process.env.MEMORY_TEST_TOKEN
    expect(
      await memory.write({ assistant: 'reply', projectId: 'p', runId: 'r2', sessionId: 's', user: 'user' })
    ).toMatchObject({ status: 'failed' })
  } finally {
    delete process.env.MEMORY_TEST_TOKEN
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
