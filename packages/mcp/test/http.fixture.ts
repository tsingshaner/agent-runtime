// cspell:ignore onsessionclosed onsessioninitialized
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createServer } from 'node:http'

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

export const createMcpHttpPeer = async () => {
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
