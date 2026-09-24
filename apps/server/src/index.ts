import { configuredService } from './infra/service.ts'
import { specification } from './spec.ts'

export default {
  async fetch(request: Request): Promise<Response> {
    if (import.meta.dev && request.method === 'GET') {
      const { pathname } = new URL(request.url)
      if (pathname === '/spec.json') {
        return Response.json(await specification())
      }
      if (pathname === '/openapi.html') {
        return new Response(apiReference, { headers: { 'content-type': 'text/html; charset=utf-8' } })
      }
    }
    return (await configuredService()).fetch(request)
  }
}

import { apiReference } from './docs.ts'
