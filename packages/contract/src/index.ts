// cspell:ignore AGUI
// biome-ignore-all lint/style/useNamingConvention: Standard oRPC error codes.
import { type AGUIEvent, EventSchemas } from '@ag-ui/core'
import { asyncIteratorObject, oc } from '@orpc/contract'
import { openapi } from '@orpc/openapi'
import * as v from 'valibot'

import type { ZodType, ZodTypeDef } from 'zod'

import * as s from './schemas'

const eventSchema: ZodType<AGUIEvent, ZodTypeDef, unknown> = EventSchemas

const base = oc.meta(openapi({ inputStructure: 'detailed', requestBodyHint: 'json' })).errors({
  BAD_REQUEST: { message: 'Invalid input' },
  CONFLICT: { data: v.object({ code: v.string() }), message: 'Operation conflicts with current state' },
  FORBIDDEN: { message: 'Forbidden' },
  GONE: { message: 'Event history cleared' },
  INTERNAL_SERVER_ERROR: { message: 'Internal error' },
  NOT_FOUND: { message: 'Not found' },
  SERVICE_UNAVAILABLE: { message: 'Service unavailable' },
  UNAUTHORIZED: { message: 'Unauthorized' }
})
const route = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: `/${string}`) => base.meta(openapi({ method, path }))
const params = v.strictObject({ id: s.text })
const byId = v.object({ params })
const withBody = <S extends v.GenericSchema>(body: S) => v.object({ body })
const idBody = <S extends v.GenericSchema>(body: S) => v.object({ body, params })
const query = <S extends v.GenericSchema>(schema: S) => v.object({ query: schema })
const idQuery = <S extends v.GenericSchema>(schema: S) => v.object({ params, query: schema })
const itemParams = v.strictObject({ id: s.text, item: s.text })
const byItem = v.object({ params: itemParams })
const empty = v.strictObject({})
const done = v.object({})
const search = v.strictObject({ q: s.text })
const binding = <S extends v.GenericSchema>(name: 'skills' | 'mcp', schema: S) => ({
  bind: route('POST', `/projects/{id}/${name}/{item}`)
    .input(v.object({ body: v.strictObject({ enabled: v.boolean() }), params: itemParams }))
    .output(done),
  list: route('GET', `/projects/{id}/${name}`).input(byId).output(v.array(schema)),
  unbind: route('DELETE', `/projects/{id}/${name}/{item}`).input(byItem).output(done)
})

export const contract = {
  health: route('GET', '/health').output(v.object({ status: v.literal('ready') })),
  knowledge: {
    bind: route('POST', '/projects/{id}/knowledge/binding')
      .input(idBody(v.strictObject({ directory: s.text })))
      .output(done),
    binding: route('GET', '/projects/{id}/knowledge/binding')
      .input(byId)
      .output(v.object({ directory: v.string() })),
    create: route('POST', '/projects/{id}/knowledge/documents').input(idBody(s.document)).output(done),
    delete: route('DELETE', '/projects/{id}/knowledge/documents')
      .input(idQuery(v.strictObject({ path: s.text })))
      .output(done),
    documents: route('GET', '/projects/{id}/knowledge/documents')
      .input(idQuery(v.strictObject({ path: v.optional(s.text) })))
      .output(v.union([v.array(v.string()), s.content])),
    edit: route('PATCH', '/projects/{id}/knowledge/documents').input(idBody(s.document)).output(done),
    search: route('GET', '/projects/{id}/knowledge/search')
      .input(idQuery(search))
      .output(v.array(v.object({ excerpt: v.string(), path: v.string() }))),
    unbind: route('DELETE', '/projects/{id}/knowledge/binding').input(byId).output(done)
  },
  mcp: {
    create: route('POST', '/mcp').input(withBody(s.mcpConfig)).output(s.mcpServer),
    delete: route('DELETE', '/mcp/{id}').input(byId).output(done),
    get: route('GET', '/mcp/{id}').input(byId).output(s.mcpServer),
    list: route('GET', '/mcp').output(v.array(s.mcpServer)),
    probe: route('POST', '/mcp/{id}/probe').input(idBody(empty)).output(v.array(s.tool)),
    update: route('PATCH', '/mcp/{id}').input(idBody(s.mcpConfig)).output(done)
  },
  memory: {
    conversations: route('GET', '/projects/{id}/memory/conversations')
      .input(idQuery(s.memoryPage))
      .output(s.conversations),
    core: route('GET', '/projects/{id}/memory/core').input(byId).output(s.core),
    delete: route('DELETE', '/projects/{id}/memory').input(idBody(s.ids)).output(s.deleted),
    deleteConversations: route('DELETE', '/projects/{id}/memory/conversations').input(idBody(s.ids)).output(s.deleted),
    query: route('GET', '/projects/{id}/memory').input(idQuery(s.memoryPage)).output(s.atomicPage),
    search: route('GET', '/projects/{id}/memory/search').input(idQuery(search)).output(s.atomicSearch),
    update: route('PATCH', '/projects/{id}/memory/{item}')
      .input(v.object({ body: s.content, params: itemParams }))
      .output(s.atomicUpdate),
    writeCore: route('PATCH', '/projects/{id}/memory/core').input(idBody(s.content)).output(s.coreUpdated)
  },
  memoryCore: {
    install: route('POST', '/memory-core/install')
      .input(withBody(v.strictObject({ archivePath: v.optional(s.text) })))
      .output(s.coreStatus),
    start: route('POST', '/memory-core/start').input(withBody(empty)).output(s.coreStatus),
    status: route('GET', '/memory-core').output(s.coreStatus),
    stop: route('POST', '/memory-core/stop').input(withBody(empty)).output(s.coreStatus)
  },
  projects: {
    create: route('POST', '/projects').input(withBody(s.projectCreate)).output(s.project),
    get: route('GET', '/projects/{id}').input(byId).output(s.project),
    list: route('GET', '/projects').input(query(s.page)).output(s.paged(s.project)),
    mcp: binding('mcp', s.mcpServer),
    memoryWrites: route('GET', '/projects/{id}/memory-writes').input(byId).output(v.array(s.memoryWrite)),
    refresh: route('POST', '/projects/{id}/resources').input(idBody(empty)).output(done),
    skills: binding('skills', s.skill),
    update: route('PATCH', '/projects/{id}').input(idBody(s.projectUpdate)).output(s.project)
  },
  runs: {
    answer: route('POST', '/runs/{id}/inputs/{item}')
      .input(v.object({ body: v.strictObject({ answers: s.answers }), params: itemParams }))
      .output(done),
    approvals: route('GET', '/runs/{id}/approvals').input(byId).output(v.array(s.approval)),
    approve: route('POST', '/runs/{id}/approvals/{item}')
      .input(v.object({ body: v.strictObject({ decision: s.decision }), params: itemParams }))
      .output(done),
    cancel: route('POST', '/runs/{id}/cancel').input(byId).output(done),
    clearEvents: route('DELETE', '/runs/{id}/events').input(byId).output(done),
    events: route('GET', '/runs/{id}/events')
      .input(idQuery(v.strictObject({ afterSequence: v.optional(s.count) })))
      .output(asyncIteratorObject(eventSchema, v.void())),
    get: route('GET', '/runs/{id}').input(byId).output(s.run),
    inputs: route('GET', '/runs/{id}/inputs').input(byId).output(v.array(s.inputRequest)),
    memoryWrite: route('GET', '/runs/{id}/memory-write').input(byId).output(v.nullable(s.memoryWrite))
  },
  sessions: {
    archive: route('POST', '/sessions/{id}/archive').input(byId).output(done),
    create: route('POST', '/sessions').input(withBody(s.sessionCreate)).output(s.session),
    get: route('GET', '/sessions/{id}').input(byId).output(s.session),
    list: route('GET', '/sessions')
      .input(
        query(
          v.strictObject({
            ...s.page.entries,
            archived: v.optional(v.boolean()),
            projectId: v.optional(s.text),
            runtime: v.optional(s.text)
          })
        )
      )
      .output(s.paged(s.session)),
    resume: route('POST', '/sessions/{id}/resume').input(byId).output(s.session),
    run: route('POST', '/sessions/{id}/runs')
      .input(idBody(v.strictObject({ requestId: v.optional(s.text), text: s.text })))
      .output(v.object({ runId: s.text, sessionId: s.text })),
    runs: route('GET', '/sessions/{id}/runs').input(idQuery(s.page)).output(s.paged(s.run)),
    unarchive: route('POST', '/sessions/{id}/unarchive').input(byId).output(done)
  },
  skills: {
    delete: route('DELETE', '/skills/{id}').input(byId).output(done),
    edit: route('PATCH', '/skills/{id}/file').input(idBody(s.document)).output(done),
    get: route('GET', '/skills/{id}').input(byId).output(s.skill),
    import: route('POST', '/skills')
      .input(withBody(v.strictObject({ source: s.text })))
      .output(s.skill),
    list: route('GET', '/skills').output(v.array(s.skill)),
    read: route('GET', '/skills/{id}/file')
      .input(idQuery(v.strictObject({ path: v.optional(s.text, 'SKILL.md') })))
      .output(s.content)
  }
}

export { EventSchemas }

export type RuntimeContractClient<C extends object = Record<never, never>> =
  import('@orpc/contract').RouterContractClient<typeof contract, C>
