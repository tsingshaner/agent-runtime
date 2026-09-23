import { openapi } from '@orpc/openapi'
import * as z from 'zod/mini'

import { base, byId, done, empty, idBody, withBody } from './base'
import * as s from './schemas'

const mcpBase = base.meta(openapi({ tags: ['MCP'] }))

export const mcp = {
  create: mcpBase
    .meta(
      openapi({
        description:
          'Creates a managed stdio or HTTP MCP configuration. Credential fields reference environment variable names rather than secret values.',
        method: 'POST',
        operationId: 'createMcpServer',
        path: '/mcp',
        summary: 'Create an MCP server configuration'
      })
    )
    .input(withBody(s.mcpConfig))
    .output(s.mcpServer),
  delete: mcpBase
    .meta(
      openapi({
        description:
          'Removes the shared configuration after existing runs drain and reapplies affected project resources.',
        method: 'DELETE',
        operationId: 'deleteMcpServer',
        path: '/mcp/{id}',
        summary: 'Delete an MCP server configuration'
      })
    )
    .input(byId)
    .output(done),
  get: mcpBase
    .meta(
      openapi({
        description: 'Returns a managed MCP configuration, including credential environment variable references.',
        method: 'GET',
        operationId: 'getMcpServer',
        path: '/mcp/{id}',
        summary: 'Get an MCP server configuration'
      })
    )
    .input(byId)
    .output(s.mcpServer),
  list: mcpBase
    .meta(
      openapi({
        description: 'Lists managed MCP configurations independently of project bindings.',
        method: 'GET',
        operationId: 'listMcpServers',
        path: '/mcp',
        summary: 'List MCP server configurations'
      })
    )
    .output(z.array(s.mcpServer)),
  probe: mcpBase
    .meta(
      openapi({
        description:
          'Opens a temporary connection, discovers available tools and releases the connection before returning.',
        method: 'POST',
        operationId: 'probeMcpServer',
        path: '/mcp/{id}/probe',
        summary: 'Probe an MCP server'
      })
    )
    .input(idBody(empty))
    .output(z.array(s.tool)),
  update: mcpBase
    .meta(
      openapi({
        description:
          'Validates the complete replacement configuration, waits for existing runs to drain and reapplies shared project resources.',
        method: 'PATCH',
        operationId: 'updateMcpServer',
        path: '/mcp/{id}',
        summary: 'Replace an MCP server configuration'
      })
    )
    .input(idBody(s.mcpConfig))
    .output(done)
}
