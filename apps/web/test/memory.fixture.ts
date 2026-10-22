import { once } from 'node:events'
import { createServer } from 'node:http'

export const createMemoryPeer = async () => {
  const entries = new Map<
    string,
    { id: string; content: string; type: string; background: string; created_at: string; updated_at: string }[]
  >()
  const writes: string[] = []
  let unavailable = false
  let uncertain = false
  const server = createServer((request, response) => {
    void (async () => {
      const body = JSON.parse(Buffer.concat(await Array.fromAsync(request)).toString())
      if (unavailable) {
        response.writeHead(503).end('private-service-secret')
        return
      }
      const project = String(body.team_id)
      const items = entries.get(project) ?? []
      let data: unknown
      switch (request.url?.split('/').slice(-2).join('/')) {
        case 'atomic/query':
          data = { items: items.slice(body.offset, body.offset + body.limit), total: items.length }
          break
        case 'atomic/search':
          data = {
            items: items.filter((item) => item.content.includes(body.query)).map((item) => ({ ...item, score: 1 }))
          }
          break
        case 'atomic/delete': {
          const remaining = items.filter((item) => !body.ids.includes(item.id))
          entries.set(project, remaining)
          data = { deleted_count: items.length - remaining.length }
          break
        }
        case 'conversation/add':
          writes.push(project)
          if (uncertain) {
            request.socket.destroy()
            return
          }
          data = { accepted_ids: ['user', 'assistant'], total_count: 2 }
          break
        case 'core/read':
          data = { content: null, created_at: null, updated_at: null }
          break
        default:
          data = { entries: [] }
      }
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ code: 0, data }))
    })().catch(() => response.destroy())
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing address')
  return {
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
    endpoint: `http://127.0.0.1:${address.port}`,
    entries,
    fail: (value: boolean) => {
      unavailable = value
    },
    loseReceipt: () => {
      uncertain = true
    },
    writes
  }
}
