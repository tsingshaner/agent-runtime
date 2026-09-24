import { timingSafeEqual } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'

import type { IncomingMessage, ServerResponse } from 'node:http'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'

import type { Context } from '@deepseek-ai/cordis'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'

const readBody = async (request: IncomingMessage) => {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    size += chunk.length
    if (size > 1048576) {
      throw new Error('Request too large')
    }
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString())
}

import { interactions } from './interactions.ts'

export const name = 'managed-runtime-control'
export const inject = ['agents', 'sessions', 'tools', 'userQuestions']
export const apply = async (ctx: Context) => {
  const token = process.env.RUNTIME_DSH_TOKEN
  const addressFile = process.env.RUNTIME_DSH_ADDRESS
  const id = process.env.RUNTIME_DSH_SESSION
  const model = process.env.RUNTIME_DSH_MODEL
  if (!(token && addressFile && id && model)) {
    throw new Error('Missing runtime control configuration')
  }
  let owned: AgentHandle | undefined
  let stream: ServerResponse | undefined
  const send = (frame: unknown) => {
    if (!stream) {
      return
    }
    if (stream.writableLength > 1048576) {
      owned?.agent.cancel({ kind: 'hook', reason: 'Control buffer exceeded' })
      stream.destroy()
      return
    }
    stream.write(`${JSON.stringify(frame)}\n`)
  }
  const respond = interactions(ctx, id, (notice) => send({ kind: 'notice', notice }))
  ctx.on('session/event', (session, event) => {
    if (session.id === id) {
      send({ event, kind: 'session' })
    }
  })
  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    if (agent.id === id) {
      send({ frame, kind: 'stream' })
    }
  })
  const run = async (body: { text?: unknown }, response: ServerResponse) => {
    if (owned?.agent.status !== 'idle' || stream || typeof body.text !== 'string' || !body.text) {
      throw new Error('Not ready')
    }
    stream = response
    response.writeHead(200, { 'content-type': 'application/x-ndjson' })
    response.flushHeaders()
    response.once('close', () => {
      if (stream === response) {
        owned?.agent.cancel({ kind: 'hook', reason: 'Control disconnected' })
        stream = undefined
      }
    })
    owned.agent.followup(createUserMessage({ content: [{ text: body.text, type: 'text' }], source: { kind: 'user' } }))
    await owned.agent.whenIdle()
    const session = ctx.sessions.get(SessionId(id))
    if (!session) {
      throw new Error('Session missing')
    }
    await ctx.sessions.flush(session)
    send({ kind: 'idle' })
    stream = undefined
    response.end()
    return
  }
  const operate = async (
    path: string | undefined,
    body: { text?: unknown; id?: unknown; decision?: unknown; answers?: unknown },
    response: ServerResponse
  ) => {
    switch (path) {
      case '/create':
      case '/resume': {
        if (owned) {
          throw new Error('Already loaded')
        }
        owned =
          path === '/create'
            ? await ctx.agents.create({
                agentOptions: { model, provider: 'deepseek-official' },
                meta: { cwd: process.cwd() },
                sessionId: SessionId(id)
              })
            : await ctx.agents.resume({
                agentOptions: { model, provider: 'deepseek-official' },
                resumeSessionId: SessionId(id)
              })
        const session = ctx.sessions.get(SessionId(id))
        if (!session) {
          throw new Error('Missing session')
        }
        await ctx.sessions.flush(session)
        response.end(JSON.stringify({ id }))
        return
      }
      case '/run':
        await run(body, response)
        return
      case '/respond':
        respond(body)
        response.end('{}')
        return
      case '/cancel':
        if (!owned) {
          throw new Error('Missing session')
        }
        owned.agent.cancel({ kind: 'user' })
        response.end('{}')
        return
      default:
        throw new Error('Unknown method')
    }
  }
  const server = createServer(async (request, response) => {
    const supplied = Buffer.from(request.headers.authorization ?? '')
    const expected = Buffer.from(`Bearer ${token}`)
    if (
      request.headers.origin ||
      request.headers.host !== host ||
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected)
    ) {
      response.writeHead(401).end('{}')
      return
    }
    try {
      if (request.method !== 'POST') {
        throw new Error('Unsupported method')
      }
      const body = await readBody(request)
      await operate(request.url, body, response)
    } catch {
      if (!response.headersSent) {
        response.writeHead(409)
      }
      response.end(JSON.stringify({ error: 'DSH_OPERATION_REJECTED' }))
    }
  })
  let host = ''
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Missing address')
  }
  host = `127.0.0.1:${address.port}`
  await writeFile(addressFile, JSON.stringify({ pid: process.pid, port: address.port }), { mode: 0o600 })
  ctx.effect(() => async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await owned?.dispose()
  })
}
