import { createService, type ServerOptions } from '../src/index'

/** Exercise the production Fetch boundary without owning an HTTP listener. */
export const openTestService = async (options: Omit<ServerOptions, 'origin'>) => {
  const url = 'http://127.0.0.1:4310'
  const service = await createService({ ...options, origin: url })
  const fetchRequest: typeof fetch = (input, init) => {
    const request = new Request(input, init)
    if (!request.headers.has('host')) {
      request.headers.set('host', new URL(request.url).host)
    }
    return service.fetch(request)
  }
  return { close: service.close, fetch: fetchRequest, token: service.token, url }
}
