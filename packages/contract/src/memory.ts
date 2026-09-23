import { openapi } from '@orpc/openapi'
import * as z from 'zod/mini'

import { base, byId, idBody, idQuery, itemParams, search } from './base'
import * as s from './schemas'

const memoryBase = base.meta(openapi({ tags: ['Memory'] }))

export const memory = {
  conversations: memoryBase
    .meta(
      openapi({
        description:
          'Queries project conversation records using limit and offset pagination. Requires a configured memory service.',
        method: 'GET',
        operationId: 'listMemoryConversations',
        path: '/projects/{id}/memory/conversations',
        summary: 'List stored conversations'
      })
    )
    .input(idQuery(s.memoryPage))
    .output(s.conversations),
  core: memoryBase
    .meta(
      openapi({
        description:
          'Returns project core memory and timestamps. Content and timestamps may be null when no core memory has been generated.',
        method: 'GET',
        operationId: 'getProjectCoreMemory',
        path: '/projects/{id}/memory/core',
        summary: 'Read project core memory'
      })
    )
    .input(byId)
    .output(s.core),
  delete: memoryBase
    .meta(
      openapi({
        description:
          'Deletes the specified atomic memory IDs within the project. Does not delete conversation records.',
        method: 'DELETE',
        operationId: 'deleteProjectMemories',
        path: '/projects/{id}/memory',
        summary: 'Delete project memories'
      })
    )
    .input(idBody(s.ids))
    .output(s.deleted),
  deleteConversations: memoryBase
    .meta(
      openapi({
        description: 'Deletes the specified conversation message IDs within the project.',
        method: 'DELETE',
        operationId: 'deleteMemoryConversations',
        path: '/projects/{id}/memory/conversations',
        summary: 'Delete stored conversation messages'
      })
    )
    .input(idBody(s.ids))
    .output(s.deleted),
  query: memoryBase
    .meta(
      openapi({
        description: 'Queries atomic project memories using limit and offset pagination.',
        method: 'GET',
        operationId: 'listProjectMemories',
        path: '/projects/{id}/memory',
        summary: 'List project memories'
      })
    )
    .input(idQuery(s.memoryPage))
    .output(s.atomicPage),
  search: memoryBase
    .meta(
      openapi({
        description: 'Searches atomic memories within the project and returns matching entries with relevance scores.',
        method: 'GET',
        operationId: 'searchProjectMemories',
        path: '/projects/{id}/memory/search',
        summary: 'Search project memories'
      })
    )
    .input(idQuery(search))
    .output(s.atomicSearch),
  update: memoryBase
    .meta(
      openapi({
        description: 'Replaces the content of the atomic memory identified by item within the project.',
        method: 'PATCH',
        operationId: 'updateProjectMemory',
        path: '/projects/{id}/memory/{item}',
        summary: 'Update a project memory'
      })
    )
    .input(z.object({ body: s.content, params: itemParams }))
    .output(s.atomicUpdate),
  writeCore: memoryBase
    .meta(
      openapi({
        description: 'Replaces project core memory content and returns its updated timestamp.',
        method: 'PATCH',
        operationId: 'writeProjectCoreMemory',
        path: '/projects/{id}/memory/core',
        summary: 'Write project core memory'
      })
    )
    .input(idBody(s.content))
    .output(s.coreUpdated)
}
