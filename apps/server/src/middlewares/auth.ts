import { randomBytes, timingSafeEqual } from 'node:crypto'

import { ORPCError } from '@orpc/server'
import { betterAuth } from 'better-auth'
import { memoryAdapter } from 'better-auth/adapters/memory'
import { APIError, createAuthEndpoint } from 'better-auth/api'
import { setSessionCookie } from 'better-auth/cookies'
import { customSession } from 'better-auth/plugins'
import * as z from 'zod'

const equal = (actual: string, expected: string) => {
  const a = Buffer.from(actual)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

const checkOrigin = (request: Request, origin: string, origins: string[] | undefined, authRoute: boolean) => {
  const host = new URL(origin).host
  const requestOrigin = request.headers.get('origin')
  const bearer = request.headers.get('authorization')
  if (
    request.headers.get('host') !== host ||
    (requestOrigin && requestOrigin !== origin && !origins?.includes(requestOrigin))
  ) {
    throw new ORPCError('FORBIDDEN')
  }
  // Browser credentials cannot inherit the optional cross-origin Bearer allowlist.
  if (
    (authRoute || (!bearer && request.headers.has('cookie'))) &&
    (requestOrigin || !['GET', 'HEAD'].includes(request.method)) &&
    requestOrigin !== origin
  ) {
    throw new ORPCError('FORBIDDEN')
  }
}

export const createAuthorization = (token: string, origin: string, origins?: string[]) => {
  const owner = {
    createdAt: new Date(),
    email: 'owner@localhost',
    emailVerified: true,
    id: 'owner',
    name: 'Owner',
    updatedAt: new Date()
  }
  const auth = betterAuth({
    advanced: { defaultCookieAttributes: { sameSite: 'strict' }, useSecureCookies: origin.startsWith('https:') },
    basePath: '/auth',
    baseURL: origin,
    // Sessions intentionally live for this service process; restart revokes every login.
    database: memoryAdapter({ account: [], session: [], user: [owner], verification: [] }),
    plugins: [
      {
        endpoints: {
          signInToken: createAuthEndpoint(
            '/sign-in/token',
            { body: z.strictObject({ token: z.string().min(1).max(256) }), method: 'POST' },
            async (ctx) => {
              if (!equal(ctx.body.token, token)) {
                throw new APIError('UNAUTHORIZED', { message: 'Invalid access token' })
              }
              const session = await ctx.context.internalAdapter.createSession(owner.id)
              if (!session) {
                throw new APIError('INTERNAL_SERVER_ERROR', { message: 'Could not create session' })
              }
              await setSessionCookie(ctx, { session, user: owner })
              return ctx.json({ authenticated: true })
            }
          )
        },
        id: 'access-token'
      },
      customSession(async ({ user, session }) => ({ session: { ...session, token: undefined }, user }))
    ],
    secret: randomBytes(32).toString('hex'),
    session: { cookieCache: { enabled: false }, disableSessionRefresh: true, expiresIn: 7 * 24 * 60 * 60 },
    trustedOrigins: [origin]
  })
  return async (request: Request, headers: Headers): Promise<Response | undefined> => {
    const requestOrigin = request.headers.get('origin')
    const bearer = request.headers.get('authorization')
    const path = new URL(request.url).pathname
    const authRoute = path.startsWith('/auth/')
    checkOrigin(request, origin, origins, authRoute)
    if (requestOrigin) {
      headers.set('access-control-allow-origin', requestOrigin)
      headers.set('vary', 'Origin')
    }
    if (request.method === 'OPTIONS' && requestOrigin) {
      headers.set('access-control-allow-methods', 'GET, POST, PATCH, DELETE')
      headers.set('access-control-allow-headers', 'Authorization, Content-Type, Last-Event-ID, A2A-Version')
      return new Response(null, { headers, status: 204 })
    }
    if (authRoute) {
      if (
        !['GET /auth/get-session', 'POST /auth/sign-in/token', 'POST /auth/sign-out'].includes(
          `${request.method} ${path}`
        )
      ) {
        throw new ORPCError('NOT_FOUND')
      }
      const response = await auth.handler(request)
      headers.forEach((value, key) => {
        response.headers.set(key, value)
      })
      return response
    }
    if (bearer ? !equal(bearer, `Bearer ${token}`) : !(await auth.api.getSession({ headers: request.headers }))) {
      throw new ORPCError('UNAUTHORIZED')
    }
    return undefined
  }
}
