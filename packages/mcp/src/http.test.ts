import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { expect, test } from 'vitest'

import { Mcp } from './index'

const peer = async () => {
  const sessions = new Map<string, { server: Server; transport: StreamableHTTPServerTransport }>()
  const http = createServer((request, response) => {
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Controlled HTTP peer handles session setup and intentional faults.
    void (async () => {
      if (request.headers.authorization !== 'secret-http-token') {
        response.writeHead(401).end()
        return
      }
      const sessionId = request.headers['mcp-session-id']
      let session = typeof sessionId === 'string' ? sessions.get(sessionId) : undefined
      if (!session) {
        const transport = new StreamableHTTPServerTransport({
          onsessionclosed: (id) => {
            sessions.delete(id)
          },
          onsessioninitialized: (id) => {
            sessions.set(id, { server, transport })
          },
          sessionIdGenerator: randomUUID
        })
        const server = new Server({ name: 'http-fixture', version: '1.0.0' }, { capabilities: { tools: {} } })
        server.setRequestHandler(ListToolsRequestSchema, async () => ({
          tools: [{ inputSchema: { type: 'object' as const }, name: 'echo' }]
        }))
        server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
          if (params.arguments?.wait) {
            await new Promise(() => {})
          }
          return { content: [{ text: 'streamed secret-http-token', type: 'text' as const }] }
        })
        await server.connect(transport)
        session = { server, transport }
      }
      const chunks: Buffer[] = []
      for await (const chunk of request) {
        chunks.push(chunk)
      }
      const body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString()) : undefined
      if (body?.params?.arguments?.disconnect) {
        response.destroy()
        return
      }
      await session.transport.handleRequest(request, response, body)
    })().catch(() => {
      if (!response.headersSent) {
        response.writeHead(500)
      }
      response.end()
    })
  })
  http.listen(0, '127.0.0.1')
  await once(http, 'listening')
  const address = http.address()
  if (!address || typeof address === 'string') {
    throw new Error('Missing address')
  }
  return {
    active: () => sessions.size,
    close: async () => {
      await Promise.all([...sessions.values()].map(({ server }) => server.close()))
      http.closeAllConnections()
      await new Promise<void>((resolve) => http.close(() => resolve()))
    },
    url: `http://127.0.0.1:${address.port}/mcp`
  }
}

test('uses real HTTP SSE responses, credentials, session termination and mixed transport conflicts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mcp-http-'))
  const http = await peer()
  const mcp = await Mcp.open(directory)
  process.env.MCP_HTTP_SECRET = 'secret-http-token'
  try {
    const remote = await mcp.create({
      headers: { Authorization: 'MCP_HTTP_SECRET' },
      name: 'remote',
      timeoutMs: 500,
      transport: 'http',
      url: http.url
    })
    await mcp.bind('p', remote.id, true)
    const connection = await mcp.connect('p')
    expect(await connection.callTool('echo', {})).toMatchObject({ content: [{ text: 'streamed [REDACTED]' }] })
    await connection.close()
    expect(http.active()).toBe(0)
    const local = await mcp.create({
      args: [resolve(import.meta.dirname, '../test/server.fixture.ts')],
      command: process.execPath,
      name: 'local',
      transport: 'stdio'
    })
    await mcp.bind('p', local.id, true)
    await expect(mcp.connect('p')).rejects.toMatchObject({ code: 'TOOL_CONFLICT' })
    expect(http.active()).toBe(0)
    await mcp.bind('p', local.id, false)
    const disconnected = await mcp.connect('p')
    await expect(disconnected.callTool('echo', { disconnect: true })).rejects.toMatchObject({ code: 'MCP_CALL_FAILED' })
    expect(http.active()).toBe(0)
    const timed = await mcp.connect('p')
    await expect(timed.callTool('echo', { wait: true })).rejects.toMatchObject({ code: 'MCP_TIMEOUT' })
    expect(http.active()).toBe(0)
  } finally {
    await mcp.dispose()
    await http.close()
    delete process.env.MCP_HTTP_SECRET
    await rm(directory, { force: true, recursive: true })
  }
}, 10000)

test('contains initialization cleanup failures and classifies HTTP notification timeouts', async () => {
  for (const mode of ['invalid', 'timeout']) {
    const directory = await mkdtemp(join(tmpdir(), 'mcp-http-init-'))
    const http = createServer((request, response) => {
      // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Two intentional protocol failure modes share one real HTTP peer.
      void (async () => {
        if (request.method === 'DELETE') {
          response.writeHead(500).end()
          return
        }
        if (request.method !== 'POST') {
          response.writeHead(405).end()
          return
        }
        const chunks: Buffer[] = []
        for await (const chunk of request) {
          chunks.push(chunk)
        }
        const message = JSON.parse(Buffer.concat(chunks).toString())
        if (message.method === 'notifications/initialized') {
          return
        }
        response.writeHead(200, {
          'content-type': 'application/json',
          ...(mode === 'invalid' ? { 'mcp-session-id': 'broken' } : {})
        })
        response.end(
          JSON.stringify({
            id: message.id,
            jsonrpc: '2.0',
            result:
              mode === 'invalid'
                ? {}
                : { capabilities: {}, protocolVersion: '2025-03-26', serverInfo: { name: 'test', version: '1' } }
          })
        )
      })().catch(() => response.destroy())
    })
    http.listen(0, '127.0.0.1')
    await once(http, 'listening')
    const address = http.address()
    if (!address || typeof address === 'string') {
      throw new Error('Missing address')
    }
    const mcp = await Mcp.open(directory)
    try {
      const config = await mcp.create({
        name: 'broken',
        timeoutMs: 100,
        transport: 'http',
        url: `http://127.0.0.1:${address.port}`
      })
      await expect(mcp.probe(config.id)).rejects.toMatchObject({
        code: mode === 'invalid' ? 'MCP_CLOSE_FAILED' : 'MCP_TIMEOUT'
      })
    } finally {
      await mcp.dispose().catch(() => {})
      http.closeAllConnections()
      await new Promise<void>((resolve) => http.close(() => resolve()))
      await rm(directory, { force: true, recursive: true })
    }
  }
})
