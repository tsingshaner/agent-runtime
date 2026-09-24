// cspell:ignore unstub
// biome-ignore-all lint/style/useNamingConvention: Official provider wire fields.
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { RuntimeManager } from '@qingshaner/runtime'
import { describe, expect, test, vi } from 'vitest'

import { DshRuntime } from './index'

describe('DSH through Manager', () => {
  test('creates without executing and resumes durable native history after process exit', async () => {
    vi.stubEnv('DSH_TEST_KEY', 'fixture')
    const root = await mkdtemp(join(tmpdir(), 'runtime-dsh-'))
    const requests: unknown[] = []
    const http = createServer(async (request, response) => {
      let body = ''
      for await (const chunk of request) {
        body += chunk
      }
      requests.push(JSON.parse(body))
      if (body.includes('provider-failure')) {
        response
          .writeHead(401, { 'content-type': 'application/json' })
          .end(JSON.stringify({ error: { message: 'secret-provider-diagnostic' } }))
        return
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(
        `data: ${JSON.stringify({ choices: [{ delta: requests.length === 1 ? { role: 'assistant', tool_calls: [{ function: { arguments: JSON.stringify({ command: 'printf tool-proof' }), name: 'bash' }, id: 'call-1', index: 0, type: 'function' }] } : { content: 'remembered', role: 'assistant' }, finish_reason: null, index: 0 }], id: 'fixture', model: 'deepseek-v4-flash', object: 'chat.completion.chunk' })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: requests.length === 1 ? 'tool_calls' : 'stop', index: 0 }], id: 'fixture', model: 'deepseek-v4-flash', object: 'chat.completion.chunk' })}\n\ndata: [DONE]\n\n`
      )
    })
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
    const address = http.address()
    if (!address || typeof address === 'string') {
      throw new Error('No address')
    }
    const open = () =>
      RuntimeManager.open({
        dataDir: join(root, 'manager'),
        runtimes: [
          new DshRuntime({
            apiKeyEnv: 'DSH_TEST_KEY',
            baseURL: `http://127.0.0.1:${address.port}`,
            dataDir: join(root, 'native')
          })
        ]
      })
    let manager = await open()
    try {
      await manager.createProject({ id: 'project', name: 'Project' })
      const session = await manager.createSession({
        cwd: root,
        model: 'deepseek-v4-flash',
        projectId: 'project',
        runtime: 'dsh'
      })
      expect(requests).toHaveLength(0)
      const first = await manager.run(session.id, { text: 'Remember marker-one' })
      const events = await Array.fromAsync(manager.subscribe(first.runId))
      expect((await manager.getRun(first.runId)).status).toBe('succeeded')
      expect(
        events
          .filter(({ event }) => event.type === 'TEXT_MESSAGE_CONTENT')
          .map(({ event }) => ('delta' in event ? event.delta : ''))
          .join('')
      ).toBe('remembered')
      await manager.dispose()
      manager = await open()
      await manager.resumeSession(session.id)
      expect(requests).toHaveLength(2)
      const second = await manager.run(session.id, { text: 'Recall marker' })
      await Array.fromAsync(manager.subscribe(second.runId))
      expect((await manager.getRun(second.runId)).status).toBe('succeeded')
      expect((await manager.getSession(session.id)).nativeSessionId).toBe(session.nativeSessionId)
      expect(
        events.some(({ event }) => event.type === 'TOOL_CALL_RESULT' && event.content.includes('tool-proof'))
      ).toBe(true)
      expect(JSON.stringify(requests[2])).toContain('marker-one')
      expect(JSON.stringify(requests[2])).toContain('remembered')
      const broken = await manager.run(session.id, { text: 'provider-failure' })
      const failed = await Array.fromAsync(manager.subscribe(broken.runId))
      expect((await manager.getRun(broken.runId)).status).toBe('failed')
      expect(failed.filter(({ event }) => event.type === 'RUN_ERROR')).toHaveLength(1)
      expect(JSON.stringify(failed)).not.toContain('secret-provider-diagnostic')
      await manager.dispose()
      await rm(join(root, 'native', session.nativeSessionId, 'home'), { force: true, recursive: true })
      manager = await open()
      await expect(manager.resumeSession(session.id)).rejects.toMatchObject({ code: 'DSH_OPERATION_REJECTED' })
      expect((await manager.getSession(session.id)).nativeSessionId).toBe(session.nativeSessionId)
    } finally {
      await manager.dispose()
      vi.unstubAllEnvs()
      http.closeAllConnections()
      await new Promise<void>((resolve) => http.close(() => resolve()))
      await rm(root, { force: true, recursive: true })
    }
  }, 120_000)
})
