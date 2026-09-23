import { implement, ORPCError, withEventMeta } from '@orpc/server'
import { ProjectMemory } from '@qingshaner/memory'
import { RuntimeError } from '@qingshaner/runtime'
import { contract } from '@qingshaner/runtime-contract'
import * as z from 'zod/mini'

import type { MemoryCoreService } from '@qingshaner/memory'
import type { ManagerOptions, RuntimeManager } from '@qingshaner/runtime'

export interface ServiceOptions extends ManagerOptions {
  memoryCore?: MemoryCoreService
}
export interface ServiceContext {
  manager: RuntimeManager
  options: ServiceOptions
  shutdown: AbortSignal
}

export const safeError = (error: unknown): ORPCError<string, unknown> => {
  if (error instanceof ORPCError) {
    return error
  }
  const code =
    error instanceof Error && 'code' in error && typeof error.code === 'string' && /^[A-Z_]+$/.test(error.code)
      ? error.code
      : 'INTERNAL_ERROR'
  if (['INVALID_INPUT', 'INVALID_PATH', 'INVALID_CONFIG', 'INVALID_SKILL'].includes(code)) {
    return new ORPCError('BAD_REQUEST', { message: 'Invalid input' })
  }
  if (code.endsWith('_NOT_FOUND')) {
    return new ORPCError('NOT_FOUND', { message: 'Not found' })
  }
  if (code === 'EVENTS_CLEARED') {
    return new ORPCError('GONE', { message: 'Event history cleared' })
  }
  if (code === 'DISPOSED') {
    return new ORPCError('SERVICE_UNAVAILABLE', { message: 'Service unavailable' })
  }
  if (code === 'INTERNAL_ERROR' || code === 'STORAGE_ERROR') {
    return new ORPCError('INTERNAL_SERVER_ERROR', { message: 'Internal error' })
  }
  return new ORPCError('CONFLICT', { data: { code }, message: 'Operation conflicts with current state' })
}
const need = <T>(value: T | undefined): T => {
  if (!value) {
    throw new RuntimeError('RESOURCE_UNAVAILABLE', 'Resource service not configured')
  }
  return value
}
const done = async (operation: Promise<unknown>) => {
  await operation
  return {}
}
const implementer = implement(contract).$context<ServiceContext>()
const base = implementer.use(async ({ next }) => {
  try {
    return await next()
  } catch (error) {
    throw safeError(error)
  }
})
const project = base.use(async ({ next, context }, input) => {
  const parsed = z.safeParse(z.object({ params: z.object({ id: z.string() }) }), input)
  if (!parsed.success) {
    throw new ORPCError('BAD_REQUEST')
  }
  await context.manager.getProject(parsed.data.params.id)
  return next()
})
const memory = (context: ServiceContext) =>
  need(context.options.memory instanceof ProjectMemory ? context.options.memory : undefined)

export const router = implementer.router({
  health: base.health.handler(() => ({ status: 'ready' })),
  knowledge: {
    bind: project.knowledge.bind.handler(({ context, input }) =>
      done(
        context.manager.updateProjectResources(input.params.id, () =>
          need(context.options.resources?.options.knowledge).bind(input.params.id, input.body.directory)
        )
      )
    ),
    binding: project.knowledge.binding.handler(async ({ context, input }) => ({
      directory: await need(context.options.resources?.options.knowledge).binding(input.params.id)
    })),
    create: project.knowledge.create.handler(({ context, input }) =>
      done(
        need(context.options.resources?.options.knowledge).create(input.params.id, input.body.path, input.body.content)
      )
    ),
    delete: project.knowledge.delete.handler(({ context, input }) =>
      done(need(context.options.resources?.options.knowledge).delete(input.params.id, input.query.path))
    ),
    documents: project.knowledge.documents.handler(async ({ context, input }) =>
      input.query.path === undefined
        ? need(context.options.resources?.options.knowledge).list(input.params.id)
        : { content: await need(context.options.resources?.options.knowledge).read(input.params.id, input.query.path) }
    ),
    edit: project.knowledge.edit.handler(({ context, input }) =>
      done(
        need(context.options.resources?.options.knowledge).edit(input.params.id, input.body.path, input.body.content)
      )
    ),
    search: project.knowledge.search.handler(({ context, input }) =>
      need(context.options.resources?.options.knowledge).search(input.params.id, input.query.q)
    ),
    unbind: project.knowledge.unbind.handler(({ context, input }) =>
      done(
        context.manager.updateProjectResources(input.params.id, () =>
          need(context.options.resources?.options.knowledge).unbind(input.params.id)
        )
      )
    )
  },
  mcp: {
    create: base.mcp.create.handler(({ context, input }) =>
      need(context.options.resources?.options.mcp).create(input.body)
    ),
    delete: base.mcp.delete.handler(({ context, input }) =>
      done(
        context.manager.updateSharedResources(() =>
          need(context.options.resources?.options.mcp).delete(input.params.id)
        )
      )
    ),
    get: base.mcp.get.handler(({ context, input }) =>
      need(context.options.resources?.options.mcp).get(input.params.id)
    ),
    list: base.mcp.list.handler(({ context }) => need(context.options.resources?.options.mcp).list()),
    probe: base.mcp.probe.handler(({ context, input }) =>
      need(context.options.resources?.options.mcp).probe(input.params.id)
    ),
    update: base.mcp.update.handler(({ context, input }) =>
      done(
        context.manager.updateSharedResources(async () => {
          await need(context.options.resources?.options.mcp).update(input.params.id, input.body)
        })
      )
    )
  },
  memory: {
    conversations: project.memory.conversations.handler(({ context, input }) =>
      memory(context).conversations(input.params.id, input.query)
    ),
    core: project.memory.core.handler(({ context, input }) => memory(context).readCore(input.params.id)),
    delete: project.memory.delete.handler(({ context, input }) =>
      memory(context).delete(input.params.id, input.body.ids)
    ),
    deleteConversations: project.memory.deleteConversations.handler(({ context, input }) =>
      memory(context).deleteConversations(input.params.id, input.body.ids)
    ),
    query: project.memory.query.handler(({ context, input }) => memory(context).query(input.params.id, input.query)),
    search: project.memory.search.handler(({ context, input }) =>
      memory(context).search(input.params.id, input.query.q)
    ),
    update: project.memory.update.handler(({ context, input }) =>
      memory(context).update(input.params.id, input.params.item, input.body.content)
    ),
    writeCore: project.memory.writeCore.handler(({ context, input }) =>
      memory(context).writeCore(input.params.id, input.body.content)
    )
  },
  memoryCore: {
    install: base.memoryCore.install.handler(({ context, input }) =>
      need(context.options.memoryCore).install(input.body)
    ),
    start: base.memoryCore.start.handler(({ context }) => need(context.options.memoryCore).start()),
    status: base.memoryCore.status.handler(({ context }) => need(context.options.memoryCore).status()),
    stop: base.memoryCore.stop.handler(async ({ context }) => {
      const core = need(context.options.memoryCore)
      await core.stop()
      return core.status()
    })
  },
  projects: {
    create: base.projects.create.handler(({ context, input }) => context.manager.createProject(input.body)),
    get: base.projects.get.handler(({ context, input }) => context.manager.getProject(input.params.id)),
    list: base.projects.list.handler(({ context, input }) => context.manager.listProjects(input.query)),
    mcp: {
      bind: project.projects.mcp.bind.handler(({ context, input }) =>
        done(
          context.manager.updateProjectResources(input.params.id, () =>
            need(context.options.resources?.options.mcp).bind(input.params.id, input.params.item, input.body.enabled)
          )
        )
      ),
      list: project.projects.mcp.list.handler(({ context, input }) =>
        need(context.options.resources?.options.mcp).list(input.params.id)
      ),
      unbind: project.projects.mcp.unbind.handler(({ context, input }) =>
        done(
          context.manager.updateProjectResources(input.params.id, () =>
            need(context.options.resources?.options.mcp).unbind(input.params.id, input.params.item)
          )
        )
      )
    },
    memoryWrites: project.projects.memoryWrites.handler(({ context, input }) =>
      context.manager.listMemoryWrites(input.params.id)
    ),
    refresh: project.projects.refresh.handler(({ context, input }) =>
      done(context.manager.updateProjectResources(input.params.id, () => Promise.resolve()))
    ),
    skills: {
      bind: project.projects.skills.bind.handler(({ context, input }) =>
        done(
          context.manager.updateProjectResources(input.params.id, () =>
            need(context.options.resources?.options.skills).bind(input.params.id, input.params.item, input.body.enabled)
          )
        )
      ),
      list: project.projects.skills.list.handler(({ context, input }) =>
        need(context.options.resources?.options.skills).list(input.params.id)
      ),
      unbind: project.projects.skills.unbind.handler(({ context, input }) =>
        done(
          context.manager.updateProjectResources(input.params.id, () =>
            need(context.options.resources?.options.skills).unbind(input.params.id, input.params.item)
          )
        )
      )
    },
    update: base.projects.update.handler(({ context, input }) =>
      context.manager.updateProject(input.params.id, input.body)
    )
  },
  runs: {
    answer: base.runs.answer.handler(({ context, input }) =>
      done(context.manager.respondInput(input.params.id, input.params.item, input.body.answers))
    ),
    approvals: base.runs.approvals.handler(({ context, input }) =>
      context.manager.listPendingApprovals(input.params.id)
    ),
    approve: base.runs.approve.handler(({ context, input }) =>
      done(context.manager.respondApproval(input.params.id, input.params.item, input.body.decision))
    ),
    cancel: base.runs.cancel.handler(({ context, input }) => done(context.manager.cancel(input.params.id))),
    clearEvents: base.runs.clearEvents.handler(({ context, input }) =>
      done(context.manager.clearRunEvents(input.params.id))
    ),
    events: base.runs.events.handler(async ({ context, input, signal, lastEventId }) => {
      // Validate before creating the iterator so failures retain their HTTP status.
      const cursor = lastEventId ?? String(input.query.afterSequence ?? 0)
      if (!(/^\d+$/.test(cursor) && Number.isSafeInteger(Number(cursor)))) {
        throw new ORPCError('BAD_REQUEST')
      }
      const afterSequence = Number(cursor)
      const run = await context.manager.getRun(input.params.id)
      if (run.eventsCleared) {
        throw new ORPCError('GONE')
      }
      if (afterSequence > run.lastSequence) {
        throw new ORPCError('BAD_REQUEST')
      }
      const subscriptionSignal = signal ? AbortSignal.any([signal, context.shutdown]) : context.shutdown
      return (async function* () {
        try {
          for await (const envelope of context.manager.subscribe(input.params.id, {
            afterSequence,
            signal: subscriptionSignal
          })) {
            yield withEventMeta(envelope.event, { id: String(envelope.sequence) })
          }
        } catch (error) {
          if (!subscriptionSignal.aborted) {
            throw safeError(error)
          }
        }
      })()
    }),
    get: base.runs.get.handler(({ context, input }) => context.manager.getRun(input.params.id)),
    inputs: base.runs.inputs.handler(({ context, input }) => context.manager.listPendingInputs(input.params.id)),
    memoryWrite: base.runs.memoryWrite.handler(({ context, input }) => context.manager.getMemoryWrite(input.params.id))
  },
  sessions: {
    archive: base.sessions.archive.handler(({ context, input }) =>
      done(context.manager.archiveSession(input.params.id))
    ),
    create: base.sessions.create.handler(({ context, input }) => context.manager.createSession(input.body)),
    get: base.sessions.get.handler(({ context, input }) => context.manager.getSession(input.params.id)),
    list: base.sessions.list.handler(({ context, input }) => context.manager.listSessions(input.query)),
    resume: base.sessions.resume.handler(({ context, input }) => context.manager.resumeSession(input.params.id)),
    run: base.sessions.run.handler(({ context, input }) => context.manager.run(input.params.id, input.body)),
    runs: base.sessions.runs.handler(({ context, input }) => context.manager.listRuns(input.params.id, input.query)),
    unarchive: base.sessions.unarchive.handler(({ context, input }) =>
      done(context.manager.unarchiveSession(input.params.id))
    )
  },
  skills: {
    delete: base.skills.delete.handler(({ context, input }) =>
      done(
        context.manager.updateSharedResources(() =>
          need(context.options.resources?.options.skills).delete(input.params.id)
        )
      )
    ),
    edit: base.skills.edit.handler(({ context, input }) =>
      done(
        context.manager.updateSharedResources(() =>
          need(context.options.resources?.options.skills).edit(input.params.id, input.body.path, input.body.content)
        )
      )
    ),
    get: base.skills.get.handler(({ context, input }) =>
      need(context.options.resources?.options.skills).get(input.params.id)
    ),
    import: base.skills.import.handler(({ context, input }) =>
      need(context.options.resources?.options.skills).import(input.body.source)
    ),
    list: base.skills.list.handler(({ context }) => need(context.options.resources?.options.skills).list()),
    read: base.skills.read.handler(async ({ context, input }) => ({
      content: await need(context.options.resources?.options.skills).read(input.params.id, input.query.path)
    }))
  }
})
