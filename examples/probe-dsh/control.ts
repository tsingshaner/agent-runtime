import { timingSafeEqual } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'

import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'

import type { Context } from '@deepseek-ai/cordis'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'

export const name = 'persistent-continuation-probe'
export const inject = ['agents', 'sessions']

// Probe-only control channel: text prompts, one resumed session, loopback + bearer.
export async function apply(ctx: Context) {
  const token = process.env.DSH_PROBE_TOKEN
  const addressFile = process.env.DSH_PROBE_ADDRESS
  if (!(token && addressFile)) {
    throw new Error('Missing probe control configuration')
  }
  let owned: AgentHandle | undefined
  async function operate(method: string | undefined, path: string, id: string, text: string | null) {
    switch (`${method} ${path}`) {
      case 'POST /resume': {
        if (owned) {
          throw new Error('Already resumed')
        }
        owned = await ctx.agents.resume({
          agentOptions: { model: process.env.DSH_PROBE_MODEL, provider: 'deepseek-official' },
          resumeSessionId: SessionId(id)
        })
        return
      }
      case 'POST /run': {
        if (owned?.agent.id !== id || owned.agent.status !== 'idle') {
          throw new Error('Not ready')
        }

        if (!text || text.length > 4096) {
          throw new Error('Invalid prompt')
        }
        owned.agent.followup(createUserMessage({ content: [{ text, type: 'text' }], source: { kind: 'user' } }))
        await owned.agent.whenIdle()
        return
      }
      case 'GET /snapshot':
        return
      default:
        throw new Error('Unknown operation')
    }
  }
  const server = createServer(async (request, response) => {
    const supplied = Buffer.from(request.headers.authorization ?? '')
    const expected = Buffer.from(`Bearer ${token}`)
    response.setHeader('content-type', 'application/json')
    if (request.headers.origin || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      response.writeHead(401).end('{}')
      return
    }
    try {
      const url = new URL(request.url ?? '/', 'http://localhost')
      const id = url.searchParams.get('id')
      if (!(id && /^[a-zA-Z0-9-]{1,128}$/.test(id))) {
        response.writeHead(400).end('{}')
        return
      }
      await operate(request.method, url.pathname, id, url.searchParams.get('text'))
      const session = ctx.sessions.get(SessionId(id))
      if (!session) {
        throw new Error('Session missing')
      }
      await ctx.sessions.flush(session)
      response.end(
        JSON.stringify({
          events: session.snapshotEvents(),
          header: session.header,
          messages: session.deriveMessages(),
          pid: process.pid,
          status: ctx.agents.get(SessionId(id))?.status
        })
      )
    } catch {
      // No upstream diagnostics: they may contain prompts or provider credentials.
      response.writeHead(409).end(JSON.stringify({ error: 'SESSION_OPERATION_REJECTED' }))
    }
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Missing control address')
  }
  await writeFile(addressFile, JSON.stringify({ pid: process.pid, port: address.port }), { mode: 0o600 })
  ctx.effect(() => async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await owned?.dispose()
  })
}
