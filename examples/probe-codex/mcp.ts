import { appendFile } from 'node:fs/promises'

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

const [name, audit] = process.argv.slice(2)
if (!(name && audit)) {
  throw new Error('Expected server name and audit path')
}
const server = new Server({ name, version: '1.0.0' }, { capabilities: { tools: {} } })
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      description: 'Record the secret from the project skill.',
      inputSchema: { properties: { secret: { type: 'string' } }, required: ['secret'], type: 'object' as const },
      name: 'prove'
    }
  ]
}))
server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
  if (params.name !== 'prove' || typeof params.arguments?.secret !== 'string') {
    throw new Error('Invalid tool call')
  }
  await appendFile(audit, `${JSON.stringify({ name, secret: params.arguments.secret })}\n`)
  return { content: [{ text: `Recorded by ${name}`, type: 'text' as const }] }
})
await server.connect(new StdioServerTransport())
