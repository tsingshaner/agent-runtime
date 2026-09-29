// cspell:ignore nosniff
import { useStorage } from 'nitro/storage'

import type { ServerRequest } from 'nitro/types'

import { configuredService } from './infra/service'
import { specification } from './spec'

export default {
  async fetch(request: ServerRequest): Promise<Response> {
    if (import.meta.dev && request.method === 'GET' && request._url?.pathname === '/spec.json') {
      return Response.json(await specification())
    }
    const path = new URL(request.url).pathname
    if (request.method === 'GET' && (['/', '/login', '/workspace'].includes(path) || path.startsWith('/workspace/'))) {
      // biome-ignore lint/correctness/useHookAtTopLevel: Nitro storage is not a React hook.
      const html = await useStorage('assets:web').getItem<string>('index.html')
      if (!html) {
        return new Response('Build the web application first.', { status: 503 })
      }
      return new Response(html, {
        headers: {
          'cache-control': 'no-store',
          'content-security-policy':
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
          'content-type': 'text/html; charset=utf-8',
          'x-content-type-options': 'nosniff'
        }
      })
    }
    return (await configuredService()).fetch(request)
  }
}
