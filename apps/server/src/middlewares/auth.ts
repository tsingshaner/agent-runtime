import { timingSafeEqual } from 'node:crypto'

import { ORPCError } from '@orpc/server'

export const createAuthorization = (token: string, origin: string, origins?: string[]) => {
  const expected = Buffer.from(`Bearer ${token}`)
  const host = new URL(origin).host
  return (request: Request, headers: Headers): Response | undefined => {
    const requestOrigin = request.headers.get('origin')
    if (
      !origin ||
      request.headers.get('host') !== host ||
      (requestOrigin && requestOrigin !== origin && !origins?.includes(requestOrigin))
    ) {
      throw new ORPCError('FORBIDDEN')
    }
    if (requestOrigin) {
      headers.set('access-control-allow-origin', requestOrigin)
      headers.set('vary', 'Origin')
    }
    if (request.method === 'OPTIONS' && requestOrigin) {
      headers.set('access-control-allow-methods', 'GET, POST, PATCH, DELETE')
      headers.set('access-control-allow-headers', 'Authorization, Content-Type, Last-Event-ID, A2A-Version')
      return new Response(null, { headers, status: 204 })
    }
    const authorization = Buffer.from(request.headers.get('authorization') ?? '')
    if (authorization.length !== expected.length || !timingSafeEqual(authorization, expected)) {
      throw new ORPCError('UNAUTHORIZED')
    }
    return undefined
  }
}
