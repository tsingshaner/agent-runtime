// biome-ignore-all lint/style/useNamingConvention: Official model wire fields.
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { type ProjectResources, RuntimeManager } from '@qingshaner/runtime'

import { DshRuntime } from '../src/index'

export type Reply = string | { name: string; arguments: Record<string, unknown> } | null
export const fixture = async (
  reply: (body: unknown, index: number) => Reply,
  resources?: (root: string) => Promise<ProjectResources>
) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-controls-'))
  let requests = 0
  const server = createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) {
      body += chunk
    }
    const answer = reply(JSON.parse(body), ++requests)
    if (answer === null) {
      return
    }
    const delta =
      typeof answer === 'string'
        ? { content: answer, role: 'assistant' }
        : {
            role: 'assistant',
            tool_calls: [
              {
                function: { arguments: JSON.stringify(answer.arguments), name: answer.name },
                id: `call-${requests}`,
                index: 0,
                type: 'function'
              }
            ]
          }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end(
      `data: ${JSON.stringify({ choices: [{ delta, finish_reason: null, index: 0 }], id: `fixture-${requests}`, model: 'deepseek-v4-flash', object: 'chat.completion.chunk' })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: typeof answer === 'string' ? 'stop' : 'tool_calls', index: 0 }], id: `fixture-${requests}`, model: 'deepseek-v4-flash', object: 'chat.completion.chunk' })}\n\ndata: [DONE]\n\n`
    )
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('No fixture address')
  }
  const runtime = new DshRuntime({
    apiKeyEnv: 'DSH_TEST_KEY',
    baseURL: `http://127.0.0.1:${address.port}`,
    controlTimeoutMs: 1500,
    dataDir: join(root, 'native')
  })
  const manager = await RuntimeManager.open({
    dataDir: join(root, 'manager'),
    resources: await resources?.(root),
    runtimes: [runtime]
  })
  await manager.createProject({ id: 'project', name: 'Project' })
  const create = () =>
    manager.createSession({ cwd: root, model: 'deepseek-v4-flash', projectId: 'project', runtime: 'dsh' })
  return {
    close: async () => {
      await manager.dispose()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await rm(root, { force: true, recursive: true })
    },
    create,
    manager,
    root,
    runtime
  }
}

export const drive = async (
  manager: RuntimeManager,
  runId: string,
  onApproval?: (
    approval: import('@qingshaner/runtime').Approval
  ) => Promise<import('@qingshaner/runtime').ApprovalDecision>,
  answer?: (input: import('@qingshaner/runtime').InputRequest) => import('@qingshaner/runtime').InputAnswers
) => {
  const events: import('@qingshaner/runtime').EventEnvelope[] = []
  for await (const envelope of manager.subscribe(runId)) {
    events.push(envelope)
    const event = envelope.event
    if (event.type !== 'CUSTOM') {
      continue
    }
    if (event.name === 'runtime.approval.requested') {
      for (const approval of await manager.listPendingApprovals(runId)) {
        await manager.respondApproval(runId, approval.id, (await onApproval?.(approval)) ?? 'approve')
      }
    }
    if (event.name === 'runtime.input.requested' && answer) {
      for (const input of await manager.listPendingInputs(runId)) {
        await manager.respondInput(runId, input.id, answer(input))
      }
    }
  }
  return events
}
