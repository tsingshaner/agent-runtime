import type { ServerRequest } from 'nitro/types'

import { configuredService } from './infra/service'
import { specification } from './spec'

export default {
  async fetch(request: ServerRequest): Promise<Response> {
    if (import.meta.dev && request.method === 'GET' && request._url?.pathname === '/spec.json') {
      return Response.json(await specification())
    }
    return (await configuredService()).fetch(request)
  }
}
