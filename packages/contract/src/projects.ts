import { openapi } from '@orpc/openapi'
import * as z from 'zod/mini'

import { base, byId, done, empty, idBody, itemParams, query, withBody } from './base'
import * as s from './schemas'

const bindingBase = base.meta(openapi({ tags: ['Resource Bindings'] }))
const projectsBase = base.meta(openapi({ tags: ['Projects'] }))

const byItem = z.object({ params: itemParams })
const binding = <S extends z.ZodMiniType>(name: 'skills' | 'mcp', schema: S) => ({
  bind: bindingBase
    .meta(
      openapi({
        description:
          'Creates or updates an explicit project resource binding and its enabled state. Waits for affected runs to finish before applying the configuration.',
        method: 'POST',
        operationId: `bindProject${name === 'skills' ? 'Skill' : 'McpServer'}`,
        path: `/projects/{id}/${name}/{item}`,
        summary: `Bind a project ${name === 'skills' ? 'skill' : 'MCP server'}`
      })
    )
    .input(z.object({ body: z.strictObject({ enabled: z.boolean() }), params: itemParams }))
    .output(done),
  list: bindingBase
    .meta(
      openapi({
        description:
          'Lists explicitly bound project resources with their enabled state. Does not append globally configured resources.',
        method: 'GET',
        operationId: `listProject${name === 'skills' ? 'Skills' : 'McpServers'}`,
        path: `/projects/{id}/${name}`,
        summary: `List project ${name === 'skills' ? 'skills' : 'MCP servers'}`
      })
    )
    .input(byId)
    .output(z.array(schema)),
  unbind: bindingBase
    .meta(
      openapi({
        description:
          'Removes the project resource binding after affected runs finish. Preserves the shared managed resource.',
        method: 'DELETE',
        operationId: `unbindProject${name === 'skills' ? 'Skill' : 'McpServer'}`,
        path: `/projects/{id}/${name}/{item}`,
        summary: `Unbind a project ${name === 'skills' ? 'skill' : 'MCP server'}`
      })
    )
    .input(byItem)
    .output(done)
})

export const projects = {
  create: projectsBase
    .meta(
      openapi({
        description:
          'Creates a stable project identity with a name and optional existing working directories. Does not start a runtime process.',
        method: 'POST',
        operationId: 'createProject',
        path: '/projects',
        summary: 'Create a project'
      })
    )
    .input(withBody(s.projectCreate))
    .output(s.project),
  get: projectsBase
    .meta(
      openapi({
        description: 'Returns project metadata and working directory bindings by stable project ID.',
        method: 'GET',
        operationId: 'getProject',
        path: '/projects/{id}',
        summary: 'Get a project'
      })
    )
    .input(byId)
    .output(s.project),
  list: projectsBase
    .meta(
      openapi({
        description:
          'Returns a page of projects in descending creation order. Use nextCursor to request the next page.',
        method: 'GET',
        operationId: 'listProjects',
        path: '/projects',
        summary: 'List projects'
      })
    )
    .input(query(s.page))
    .output(s.paged(s.project)),
  mcp: binding('mcp', s.mcpServer),
  memoryWrites: base
    .meta(
      openapi({
        description:
          'Returns memory write records and their independent pending, accepted, failed or unknown status. These records do not change Run success.',
        method: 'GET',
        operationId: 'listProjectMemoryWrites',
        path: '/projects/{id}/memory-writes',
        summary: 'List project memory writes',
        tags: ['Memory']
      })
    )
    .input(byId)
    .output(z.array(s.memoryWrite)),
  refresh: projectsBase
    .meta(
      openapi({
        description:
          'Waits for affected runs to finish and reapplies project resource configuration, including externally edited resources.',
        method: 'POST',
        operationId: 'refreshProjectResources',
        path: '/projects/{id}/resources',
        summary: 'Refresh project resources'
      })
    )
    .input(idBody(empty))
    .output(done),
  skills: binding('skills', s.skill),
  update: projectsBase
    .meta(
      openapi({
        description:
          'Changes the project name or working directory bindings without changing project identity or rewriting existing session working directories.',
        method: 'PATCH',
        operationId: 'updateProject',
        path: '/projects/{id}',
        summary: 'Update project metadata'
      })
    )
    .input(idBody(s.projectUpdate))
    .output(s.project)
}
