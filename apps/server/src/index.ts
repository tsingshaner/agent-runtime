// cspell:ignore nosniff
import { randomBytes, timingSafeEqual } from 'node:crypto'

import { SmartCoercionHandlerPlugin } from '@orpc/json-schema'
import { OpenAPIGenerator } from '@orpc/openapi'
import { OpenAPIHandler } from '@orpc/openapi/fetch'
import { COMMON_ERROR_STATUS_MAP, ORPCError } from '@orpc/server'
import { RequestLimitHandlerPlugin } from '@orpc/server/plugins'
import { ZodToJsonSchemaConverter } from '@orpc/zod'
import { RuntimeManager } from '@qingshaner/runtime'
import { contract, EventSchemas } from '@qingshaner/runtime-contract'
import * as z from 'zod/mini'
import { zodToJsonSchema } from 'zod-to-json-schema'

import { router, type ServiceOptions, safeError } from './router.ts'

export type ServerOptions = ServiceOptions & { origin: string; origins?: string[] }
const generator = new OpenAPIGenerator({
  converters: [
    // AG-UI's Zod 3 schema must be handled before the Zod 4 converter.
    {
      condition: (schema) => schema === EventSchemas,
      convert: () => [
        zodToJsonSchema(EventSchemas as unknown as Parameters<typeof zodToJsonSchema>[0], { target: 'openApi3' }),
        false
      ]
    },
    new ZodToJsonSchemaConverter()
  ]
})
let spec: ReturnType<typeof generator.generate> | undefined
const specification = () =>
  (spec ??= generator.generate(contract, {
    base: {
      components: { securitySchemes: { bearerAuth: { scheme: 'bearer', type: 'http' } } },
      info: { title: 'Agent Runtime', version: '1.0.0' },
      security: [{ bearerAuth: [] }],
      servers: [{ url: '/' }]
    }
  }))
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
  const expected = Buffer.from(`Bearer ${token}`)
  const shutdown = new AbortController()
  const origin = options.origin
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
  const authorize = (request: Request, headers: Headers): Response | undefined => {
    const requestOrigin = request.headers.get('origin')
    if (
      !origin ||
      request.headers.get('host') !== new URL(origin).host ||
      (requestOrigin && requestOrigin !== origin && !options.origins?.includes(requestOrigin))
    ) {
      throw new ORPCError('FORBIDDEN')
    }
    if (requestOrigin) {
      headers.set('access-control-allow-origin', requestOrigin)
      headers.set('vary', 'Origin')
    }
    if (request.method === 'OPTIONS' && requestOrigin) {
      headers.set('access-control-allow-methods', 'GET, POST, PATCH, DELETE')
      headers.set('access-control-allow-headers', 'Authorization, Content-Type, Last-Event-ID')
      return new Response(null, { headers, status: 204 })
    }
    const authorization = Buffer.from(request.headers.get('authorization') ?? '')
    if (authorization.length !== expected.length || !timingSafeEqual(authorization, expected)) {
      throw new ORPCError('UNAUTHORIZED')
    }
    return undefined
  }
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
        request.method === 'GET' && url.pathname === '/spec.json'
          ? Response.json(await specification())
          : (await handler.handle(request, { context: { manager, options, shutdown: shutdown.signal } })).response
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
