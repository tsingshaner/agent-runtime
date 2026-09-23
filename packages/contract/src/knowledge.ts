import { openapi } from '@orpc/openapi'
import * as z from 'zod/mini'

import { base, byId, done, idBody, idQuery, search } from './base'
import * as s from './schemas'

const knowledgeBase = base.meta(openapi({ tags: ['Knowledge'] }))

export const knowledge = {
  bind: knowledgeBase
    .meta(
      openapi({
        description:
          'Binds an existing Markdown directory to the project. Waits for affected runs to finish before applying the resource configuration.',
        method: 'POST',
        operationId: 'bindProjectKnowledge',
        path: '/projects/{id}/knowledge/binding',
        summary: 'Bind a knowledge directory'
      })
    )
    .input(idBody(z.strictObject({ directory: s.text })))
    .output(done),
  binding: knowledgeBase
    .meta(
      openapi({
        description: 'Returns the Markdown directory bound to the project.',
        method: 'GET',
        operationId: 'getProjectKnowledgeBinding',
        path: '/projects/{id}/knowledge/binding',
        summary: 'Get the knowledge directory binding'
      })
    )
    .input(byId)
    .output(z.object({ directory: z.string() })),
  create: knowledgeBase
    .meta(
      openapi({
        description:
          'Creates a Markdown document at a path relative to the bound knowledge directory. Rejects paths outside that directory.',
        method: 'POST',
        operationId: 'createKnowledgeDocument',
        path: '/projects/{id}/knowledge/documents',
        summary: 'Create a knowledge document'
      })
    )
    .input(idBody(s.document))
    .output(done),
  delete: knowledgeBase
    .meta(
      openapi({
        description:
          'Deletes the document identified by the path query parameter within the bound knowledge directory.',
        method: 'DELETE',
        operationId: 'deleteKnowledgeDocument',
        path: '/projects/{id}/knowledge/documents',
        summary: 'Delete a knowledge document'
      })
    )
    .input(idQuery(z.strictObject({ path: s.text })))
    .output(done),
  documents: knowledgeBase
    .meta(
      openapi({
        description:
          'Lists document paths when path is omitted. When path is supplied, returns that document content instead.',
        method: 'GET',
        operationId: 'getKnowledgeDocuments',
        path: '/projects/{id}/knowledge/documents',
        summary: 'List or read knowledge documents'
      })
    )
    .input(idQuery(z.strictObject({ path: z.optional(s.text) })))
    .output(z.union([z.array(z.string()), s.content])),
  edit: knowledgeBase
    .meta(
      openapi({
        description: 'Atomically replaces the content of an existing document within the bound knowledge directory.',
        method: 'PATCH',
        operationId: 'editKnowledgeDocument',
        path: '/projects/{id}/knowledge/documents',
        summary: 'Edit a knowledge document'
      })
    )
    .input(idBody(s.document))
    .output(done),
  search: knowledgeBase
    .meta(
      openapi({
        description: 'Searches project Markdown documents by keyword and returns matching paths with excerpts.',
        method: 'GET',
        operationId: 'searchKnowledgeDocuments',
        path: '/projects/{id}/knowledge/search',
        summary: 'Search knowledge documents'
      })
    )
    .input(idQuery(search))
    .output(z.array(z.object({ excerpt: z.string(), path: z.string() }))),
  unbind: knowledgeBase
    .meta(
      openapi({
        description:
          'Removes the project binding after affected runs finish. Does not delete the source directory or its documents.',
        method: 'DELETE',
        operationId: 'unbindProjectKnowledge',
        path: '/projects/{id}/knowledge/binding',
        summary: 'Remove the knowledge directory binding'
      })
    )
    .input(byId)
    .output(done)
}
