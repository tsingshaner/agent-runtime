import { writeFile } from 'node:fs/promises'

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

const server = new Server({ name: 'slow-tool', version: '1.0.0' }, { capabilities: { tools: {} } })
server.setRequestHandler(ListToolsRequestSchema, () =>
  Promise.resolve({ tools: [{ inputSchema: { type: 'object' }, name: 'echo' }] })
)
server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
  await writeFile(String(params.arguments?.startedFile), 'started')
  await new Promise(() => {})
  return { content: [] }
})
await server.connect(new StdioServerTransport())
