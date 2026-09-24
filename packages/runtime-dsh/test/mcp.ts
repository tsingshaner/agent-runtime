import { createServer } from 'node:http'

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

export const httpTool = async () => {
  const peers = new Set<Server>()
  let calls = 0
  const http = createServer()
  http.on('request', (request, response) => {
    void (async () => {
      const server = new Server({ name: 'dsh-http-fixture', version: '1.0.0' }, { capabilities: { tools: {} } })
      peers.add(server)
      response.once('close', () => {
        peers.delete(server)
        void server.close().catch(() => {})
      })
      server.setRequestHandler(ListToolsRequestSchema, () =>
        Promise.resolve({
          tools: [
            {
              description: 'HTTP proof tool',
              inputSchema: { properties: { fail: { type: 'boolean' } }, type: 'object' },
              name: 'http_echo'
            }
          ]
        })
      )
      server.setRequestHandler(CallToolRequestSchema, ({ params }) => {
        calls++
        return Promise.resolve({
          content: [{ text: params.arguments?.fail ? 'ordinary-http-error' : 'http-proof', type: 'text' }],
          isError: !!params.arguments?.fail
        })
      })
      const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true, sessionIdGenerator: undefined })
      await server.connect(transport)
      await transport.handleRequest(request, response)
    })().catch(() => response.destroy())
  })
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
  const address = http.address()
  if (!address || typeof address === 'string') {
    throw new Error('Missing MCP address')
  }
  return {
    calls: () => calls,
    close: async () => {
      await Promise.all([...peers].map((peer) => peer.close()))
      http.closeAllConnections()
      await new Promise<void>((resolve) => http.close(() => resolve()))
    },
    url: `http://127.0.0.1:${address.port}/mcp`
  }
}
