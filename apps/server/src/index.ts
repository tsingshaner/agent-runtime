// cspell:ignore nosniff
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { once } from 'node:events'
import { createServer } from 'node:http'

import type { IncomingMessage, ServerResponse } from 'node:http'
import { RuntimeError, RuntimeManager } from '@qingshaner/runtime'
import * as v from 'valibot'

import type { ManagerOptions, RuntimeAdapter } from '@qingshaner/runtime'

const object = v.record(v.string(), v.unknown())
const parse = <S extends v.GenericSchema>(schema: S, input: unknown): v.InferOutput<S> => {
  const result = v.safeParse(schema, input)
  if (!result.success) {
    throw new RuntimeError('INVALID_INPUT', 'Invalid input')
  }
  return result.output
}
const body = async (request: IncomingMessage) => {
  if (request.headers['content-type']?.split(';')[0] !== 'application/json') {
    throw new RuntimeError('INVALID_INPUT', 'Expected JSON')
  }
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > 1024 * 1024) {
      throw new RuntimeError('INVALID_INPUT', 'Body too large')
    }
    chunks.push(chunk)
  }
  try {
    return parse(object, JSON.parse(Buffer.concat(chunks).toString()))
  } catch {
    throw new RuntimeError('INVALID_INPUT', 'Invalid JSON')
  }
}
const json = (response: ServerResponse, value: unknown, status = 200) => {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json',
    'x-content-type-options': 'nosniff'
  })
  response.end(JSON.stringify(value ?? {}))
}
const page = (url: URL) => {
  const result: { limit?: number; cursor?: string } = {}
  if (url.searchParams.has('limit')) {
    result.limit = Number(url.searchParams.get('limit'))
  }
  if (url.searchParams.has('cursor')) {
    result.cursor = url.searchParams.get('cursor') ?? ''
  }
  return result
}
const errorCode = (error: unknown) =>
  error instanceof RuntimeError && /^[A-Z_]+$/.test(error.code) ? error.code : 'INTERNAL_ERROR'
const statusCode = (code: string) =>
  code === 'INVALID_INPUT'
    ? 400
    : code.endsWith('_NOT_FOUND')
      ? 404
      : code === 'EVENTS_CLEARED'
        ? 410
        : code === 'INTERNAL_ERROR' || code === 'STORAGE_ERROR'
          ? 500
          : 409

/** Own one Manager and loopback HTTP listener. The returned token is never logged. */
export const startServer = async <A extends RuntimeAdapter>(
  options: ManagerOptions<A> & { port?: number; origins?: string[] }
) => {
  parse(
    v.strictObject({
      origins: v.optional(v.array(v.string())),
      port: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(65535)))
    }),
    { origins: options.origins, port: options.port }
  )
  const manager = await RuntimeManager.open({ dataDir: options.dataDir, runtimes: options.runtimes })
  const token = randomBytes(32).toString('hex')
  const expected = Buffer.from(`Bearer ${token}`)
  const subscriptions = new Set<AbortController>()
  let closing = false
  let url = ''
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Keep subscription validation and cleanup together.
  const stream = async (request: IncomingMessage, response: ServerResponse, runId: string, target: URL) => {
    const cursor = request.headers['last-event-id'] ?? target.searchParams.get('afterSequence') ?? '0'
    if (typeof cursor !== 'string' || !/^\d+$/.test(cursor)) {
      throw new RuntimeError('INVALID_INPUT', 'Invalid cursor')
    }
    const afterSequence = Number(cursor)
    const run = await manager.getRun(runId)
    if (run.eventsCleared) {
      throw new RuntimeError('EVENTS_CLEARED', 'Events cleared')
    }
    if (!Number.isSafeInteger(afterSequence) || afterSequence > run.lastSequence) {
      throw new RuntimeError('INVALID_INPUT', 'Invalid cursor')
    }
    const controller = new AbortController()
    subscriptions.add(controller)
    const abort = () => controller.abort()
    response.once('close', abort)
    response.writeHead(200, {
      'cache-control': 'no-cache',
      'content-type': 'text/event-stream',
      'x-content-type-options': 'nosniff'
    })
    response.flushHeaders()
    try {
      for await (const envelope of manager.subscribe(runId, { afterSequence, signal: controller.signal })) {
        if (!response.write(`id: ${envelope.sequence}\ndata: ${JSON.stringify(envelope.event)}\n\n`)) {
          await once(response, 'drain', { signal: controller.signal })
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        response.write(`event: error\ndata: ${JSON.stringify({ code: errorCode(error) })}\n\n`)
      }
    } finally {
      response.off('close', abort)
      subscriptions.delete(controller)
      response.end()
    }
  }
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Thin routes delegate lifecycle and validation to the Manager.
  const route = async (request: IncomingMessage, response: ServerResponse) => {
    const origin = request.headers.origin
    if (origin && origin !== url && !options.origins?.includes(origin)) {
      return json(response, { code: 'FORBIDDEN' }, 403)
    }
    if (request.headers.host !== new URL(url).host) {
      return json(response, { code: 'FORBIDDEN' }, 403)
    }
    if (origin) {
      response.setHeader('access-control-allow-origin', origin)
      response.setHeader('vary', 'Origin')
    }
    if (request.method === 'OPTIONS' && origin) {
      response.setHeader('access-control-allow-methods', 'GET, POST, PATCH, DELETE')
      response.setHeader('access-control-allow-headers', 'Authorization, Content-Type, Last-Event-ID')
      response.writeHead(204)
      response.end()
      return
    }
    const authorization = Buffer.from(request.headers.authorization ?? '')
    if (authorization.length !== expected.length || !timingSafeEqual(authorization, expected)) {
      return json(response, { code: 'UNAUTHORIZED' }, 401)
    }
    if (closing) {
      return json(response, { code: 'DISPOSED' }, 503)
    }
    let target: URL
    let parts: string[]
    try {
      target = new URL(request.url ?? '/', url)
      parts = target.pathname.split('/').filter(Boolean).map(decodeURIComponent)
    } catch {
      throw new RuntimeError('INVALID_INPUT', 'Invalid URL')
    }
    const [resource, id = '', action, item = ''] = parts
    const method = request.method
    let result: unknown
    if (method === 'GET' && target.pathname === '/health') {
      result = { status: 'ready' }
    } else if (resource === 'projects' && parts.length <= 2) {
      if (method === 'GET') {
        result = id ? await manager.getProject(id) : await manager.listProjects(page(target))
      } else if (method === 'POST' && !id) {
        result = await manager.createProject((await body(request)) as never)
      } else if (method === 'PATCH' && id) {
        result = await manager.updateProject(id, await body(request))
      } else {
        throw new RuntimeError('ROUTE_NOT_FOUND', 'Route not found')
      }
    } else if (resource === 'sessions' && parts.length <= 3) {
      if (method === 'GET' && !id) {
        const archived = target.searchParams.get('archived')
        if (archived !== null && archived !== 'true' && archived !== 'false') {
          throw new RuntimeError('INVALID_INPUT', 'Invalid archived filter')
        }
        result = await manager.listSessions({
          ...page(target),
          ...(archived === null ? {} : { archived: archived === 'true' }),
          ...(target.searchParams.has('projectId') ? { projectId: target.searchParams.get('projectId') ?? '' } : {}),
          ...(target.searchParams.has('runtime') ? { runtime: target.searchParams.get('runtime') ?? '' } : {})
        })
      } else if (method === 'GET' && id && !action) {
        result = await manager.getSession(id)
      } else if (method === 'POST' && !id) {
        result = await manager.createSession((await body(request)) as never)
      } else if (method === 'POST' && action === 'resume') {
        result = await manager.resumeSession(id)
      } else if (method === 'POST' && action === 'archive') {
        result = await manager.archiveSession(id)
      } else if (method === 'POST' && action === 'unarchive') {
        result = await manager.unarchiveSession(id)
      } else if (method === 'POST' && action === 'runs') {
        result = await manager.run(id, (await body(request)) as never)
      } else if (method === 'GET' && action === 'runs') {
        result = await manager.listRuns(id, page(target))
      } else {
        throw new RuntimeError('ROUTE_NOT_FOUND', 'Route not found')
      }
    } else if (resource === 'runs' && id && parts.length <= 4) {
      if (method === 'GET' && !action) {
        result = await manager.getRun(id)
      } else if (method === 'GET' && action === 'events' && !item) {
        return await stream(request, response, id, target)
      } else if (method === 'DELETE' && action === 'events' && !item) {
        result = await manager.clearRunEvents(id)
      } else if (method === 'POST' && action === 'cancel' && !item) {
        result = await manager.cancel(id)
      } else if (method === 'GET' && action === 'approvals' && !item) {
        result = await manager.listPendingApprovals(id)
      } else if (method === 'GET' && action === 'inputs' && !item) {
        result = await manager.listPendingInputs(id)
      } else if (method === 'POST' && action === 'approvals' && item) {
        const value = parse(v.strictObject({ decision: v.picklist(['approve', 'deny']) }), await body(request))
        result = await manager.respondApproval(id, item, value.decision)
      } else if (method === 'POST' && action === 'inputs' && item) {
        const value = parse(v.strictObject({ answers: v.record(v.string(), v.array(v.string())) }), await body(request))
        result = await manager.respondInput(id, item, value.answers)
      } else {
        throw new RuntimeError('ROUTE_NOT_FOUND', 'Route not found')
      }
    } else {
      throw new RuntimeError('ROUTE_NOT_FOUND', 'Route not found')
    }
    json(response, result)
  }
  const server = createServer((request, response) => {
    void route(request, response).catch((error: unknown) => {
      if (response.headersSent) {
        response.destroy()
      } else {
        const code = errorCode(error)
        json(response, { code }, statusCode(code))
      }
    })
  })
  server.requestTimeout = 15000
  server.headersTimeout = 10000
  try {
    server.listen(options.port ?? 0, '127.0.0.1')
    await once(server, 'listening')
  } catch (error) {
    await manager.dispose()
    throw error
  }
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Missing listener address')
  }
  url = `http://127.0.0.1:${address.port}`
  let closePromise: Promise<void> | undefined
  const close = () =>
    (closePromise ??= (async () => {
      closing = true
      const closed = new Promise<void>((resolve) => server.close(() => resolve()))
      for (const subscription of subscriptions) {
        subscription.abort()
      }
      server.closeAllConnections()
      try {
        await manager.dispose()
      } finally {
        await closed
      }
    })())
  return { close, token, url }
}
