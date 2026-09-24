// cspell:ignore nosniff
import { randomBytes } from 'node:crypto'

import { SmartCoercionHandlerPlugin } from '@orpc/json-schema'
import { OpenAPIHandler } from '@orpc/openapi/fetch'
import { COMMON_ERROR_STATUS_MAP, ORPCError } from '@orpc/server'
import { RequestLimitHandlerPlugin } from '@orpc/server/plugins'
import { ZodToJsonSchemaConverter } from '@orpc/zod'
import { createA2AHandler, RuntimeManager } from '@qingshaner/runtime'
import * as z from 'zod/mini'

import { safeError } from './error.ts'
import { createAuthorization } from './middlewares/auth.ts'
import { router, type ServiceOptions } from './router/index.ts'
import { specification } from './spec.ts'

export type ServerOptions = ServiceOptions & { origin: string; origins?: string[] }
const handler = new OpenAPIHandler(router, {
  // Validation issues can contain input values. Never return diagnostics to HTTP clients.
  interceptors: [
    async ({ next }) => {
      try {
        return await next()
      } catch (error) {
        if (error instanceof SyntaxError) {
          throw new ORPCError('BAD_REQUEST')
        }
        const safe = safeError(error)
        if (safe.code === 'BAD_REQUEST' || safe.code === 'INTERNAL_SERVER_ERROR') {
          throw new ORPCError(safe.code)
        }
        throw safe
      }
    }
  ],
  plugins: [
    new SmartCoercionHandlerPlugin({ converters: [new ZodToJsonSchemaConverter({ cache: true })] }),
    new RequestLimitHandlerPlugin({ maxBodySize: 1024 * 1024 })
  ]
})

/** Fetch handler used by Nitro. Owns one Manager, but no listener. */
export const createService = async (options: ServerOptions) => {
  z.parse(
    z.strictObject({
      origin: z.url(),
      origins: z.optional(z.array(z.string()))
    }),
    { origin: options.origin, origins: options.origins }
  )
  const manager = await RuntimeManager.open({
    dataDir: options.dataDir,
    memory: options.memory,
    memoryTimeoutMs: options.memoryTimeoutMs,
    resources: options.resources,
    runtimes: options.runtimes
  })
  const token = randomBytes(32).toString('hex')
  const authorize = createAuthorization(token, options.origin, options.origins)
  const shutdown = new AbortController()
  const a2a = createA2AHandler(manager, options.origin, shutdown.signal)
  let closePromise: Promise<void> | undefined
  const close = () =>
    (closePromise ??= (async () => {
      shutdown.abort()
      try {
        await manager.dispose()
      } finally {
        await options.memoryCore?.dispose()
      }
    })())
  const fetchRequest = async (request: Request): Promise<Response> => {
    const headers = new Headers({ 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
    try {
      const preflight = authorize(request, headers)
      if (preflight) {
        return preflight
      }
      if (shutdown.signal.aborted) {
        throw new ORPCError('SERVICE_UNAVAILABLE')
      }
      const url = new URL(request.url)
      try {
        decodeURIComponent(url.pathname)
      } catch {
        throw new ORPCError('BAD_REQUEST')
      }
      const response =
        (await a2a(request)) ??
        (request.method === 'GET' && url.pathname === '/spec.json'
          ? Response.json(await specification())
          : (await handler.handle(request, { context: { manager, options, shutdown: shutdown.signal } })).response)
      if (!response) {
        throw new ORPCError('NOT_FOUND')
      }
      headers.forEach((value, key) => {
        response.headers.set(key, value)
      })
      return response
    } catch (error) {
      const safe = safeError(error)
      return Response.json(safe.toJSON(), {
        headers,
        status: (COMMON_ERROR_STATUS_MAP as Record<string, number>)[safe.code] ?? 500
      })
    }
  }
  return {
    close,
    fetch: fetchRequest,
    token
  }
}
