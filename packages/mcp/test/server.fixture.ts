import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

const server = new Server({ name: 'fixture', version: '1.0.0' }, { capabilities: { tools: {} } })
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{ inputSchema: { type: 'object' as const }, name: 'echo' }]
}))
server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
  if (params.arguments?.fail) {
    throw new Error(`private: ${process.env.MCP_TEST_SECRET}`)
  }
  if (params.arguments?.wait) {
    await new Promise(() => {})
  }
  return {
    content: [
      {
        text: JSON.stringify({ input: params.arguments, pid: process.pid, secret: process.env.MCP_TEST_SECRET }),
        type: 'text' as const
      }
    ]
  }
})
await server.connect(new StdioServerTransport())
