// biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: Keep explicit sequential acceptance scenarios in one scoped smoke.
// biome-ignore-all lint/suspicious/noConsole: Explicit native protocol smoke reports.
// biome-ignore-all lint/suspicious/noMisplacedAssertion: Standalone smoke assertions.
// biome-ignore-all lint/style/useNamingConvention: Official model wire fields.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { launchNitro } from '../../apps/server/test/nitro.fixture.ts'

/** Real Harness and tools, deterministic model responses; no hosted provider credentials. */
const main = async () => {
  const { SendMessageRequest, TaskState } = await import('@a2a-js/sdk')
  const { ClientFactory, DefaultAgentCardResolver, JsonRpcTransportFactory } = await import('@a2a-js/sdk/client')
  const { RuntimeClient } = await import('../tanstack/client.ts')
  const directory = await mkdtemp(join(tmpdir(), 'native-protocol-'))
  const cwd = join(directory, 'project')
  await mkdir(cwd)
  let requests = 0
  const provider = createServer((request, response) => {
    void (async () => {
      let body = ''
      for await (const chunk of request) {
        body += chunk
        assert.ok(body.length < 1048576, 'Oversized model request')
      }
      const data = JSON.parse(body) as { messages: { role: string; content: unknown }[] }
      const last = data.messages.at(-1)
      assert.ok(last)
      const id = `fixture-${++requests}`
      const answered = last.role === 'tool'
      const question = JSON.stringify(last.content).includes('native-smoke:input')
      const delta = answered
        ? { content: `native-complete ${JSON.stringify(last.content)}`, role: 'assistant' }
        : {
            role: 'assistant',
            tool_calls: [
              {
                function: {
                  arguments: JSON.stringify(
                    question
                      ? { questions: [{ id: 'name', question: 'What is your name?' }] }
                      : { command: 'printf a >> effects.txt' }
                  ),
                  name: question ? 'ask_user_question' : 'bash'
                },
                id,
                index: 0,
                type: 'function'
              }
            ]
          }
      const frame = (delta: unknown, finish_reason: string | null) =>
        `data: ${JSON.stringify({ choices: [{ delta, finish_reason, index: 0 }], id, model: 'deepseek-v4-flash', object: 'chat.completion.chunk' })}\n\n`
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(`${frame(delta, null) + frame({}, answered ? 'stop' : 'tool_calls')}data: [DONE]\n\n`)
    })().catch(() => {
      if (!response.headersSent) {
        response.writeHead(500)
      }
      response.end()
    })
  })
  await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve))
  const address = provider.address()
  assert.ok(address && typeof address !== 'string')
  let server: Awaited<ReturnType<typeof launchNitro>> | undefined
  try {
    server = await launchNitro(join(directory, 'data'), {
      DEEPSEEK_API_KEY: 'local-fixture-only',
      DSH_BASE_URL: `http://127.0.0.1:${address.port}`
    })
    const { url, token } = server
    const deadline = AbortSignal.timeout(180000)
    const fetchImpl: typeof fetch = (input, init) => {
      const request = new Request(input, init)
      assert.equal(new URL(request.url).origin, url)
      request.headers.set('authorization', `Bearer ${token}`)
      return fetch(request, { redirect: 'error', signal: AbortSignal.any([request.signal, deadline]) })
    }
    assert.equal((await fetch(`${url}/.well-known/agent-card.json`)).status, 401)
    const a2a = await new ClientFactory({
      cardResolver: new DefaultAgentCardResolver({ fetchImpl }),
      transports: [new JsonRpcTransportFactory({ fetchImpl })]
    }).createFromUrl(url)
    const client = new RuntimeClient(url, token, fetchImpl)
    const project = await client.api.projects.create({ body: { name: 'Native protocol smoke' } })
    const session = () =>
      client.api.sessions.create({
        body: {
          cwd,
          model: 'deepseek-v4-flash',
          projectId: project.id,
          runtime: 'dsh'
        }
      })
    let effects = ''
    const verifyEffects = async (approved: boolean) => {
      if (approved) {
        effects += 'a'
      }
      const actual = await readFile(join(cwd, 'effects.txt'), 'utf8').catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') {
          throw error
        }
        return ''
      })
      assert.equal(actual, effects)
    }

    for (const scenario of ['input', 'approve', 'deny', 'cancel'] as const) {
      const current = await session()
      let taskId = ''
      let runId = ''
      let handled = false
      let terminals = 0
      for await (const update of a2a.sendMessageStream(
        SendMessageRequest.fromJSON({
          message: {
            contextId: current.id,
            messageId: randomUUID(),
            parts: [{ text: `native-smoke:${scenario}` }],
            role: 'ROLE_USER'
          }
        })
      )) {
        const payload = update.payload
        if (payload?.$case === 'task') {
          taskId = payload.value.id
          runId = String(payload.value.metadata?.runId ?? '')
          assert.ok(taskId && runId && taskId !== runId)
        }
        if (
          payload?.$case === 'statusUpdate' &&
          [TaskState.TASK_STATE_COMPLETED, TaskState.TASK_STATE_CANCELED, TaskState.TASK_STATE_FAILED].includes(
            payload.value.status?.state ?? -1
          )
        ) {
          terminals++
        }
        const status = payload?.$case === 'task' || payload?.$case === 'statusUpdate' ? payload.value.status : undefined
        if (status?.state !== TaskState.TASK_STATE_INPUT_REQUIRED || handled) {
          continue
        }
        handled = true
        const native = await client.api.runs.get({ params: { id: runId } })
        assert.equal(native.sessionId, current.id)
        assert.equal(native.status, scenario === 'input' ? 'waiting_input' : 'waiting_approval')
        if (scenario === 'cancel') {
          await a2a.cancelTask({ id: taskId, metadata: undefined, tenant: '' })
          continue
        }
        let reply: unknown
        if (scenario === 'input') {
          const [input] = await client.api.runs.inputs({ params: { id: runId } })
          assert.ok(input)
          assert.match(JSON.stringify(status.message?.parts), new RegExp(input.id))
          reply = { answers: { name: ['Ada'] }, inputId: input.id }
        } else {
          const [approval] = await client.api.runs.approvals({ params: { id: runId } })
          assert.ok(approval)
          assert.match(JSON.stringify(status.message?.parts), new RegExp(approval.id))
          reply = { approvalId: approval.id, decision: scenario }
        }
        const continued = await a2a.sendMessage(
          SendMessageRequest.fromJSON({
            configuration: { returnImmediately: true },
            message: {
              contextId: current.id,
              messageId: randomUUID(),
              parts: [{ data: reply }],
              role: 'ROLE_USER',
              taskId
            }
          })
        )
        assert.ok('id' in continued)
        assert.equal(continued.id, taskId)
        assert.equal(continued.metadata?.runId, runId)
      }
      assert.ok(handled, `${scenario} did not reach native interaction`)
      assert.equal(terminals, 1)
      const finished = await a2a.getTask({ id: taskId, tenant: '' })
      assert.equal(
        finished.status?.state,
        scenario === 'cancel' ? TaskState.TASK_STATE_CANCELED : TaskState.TASK_STATE_COMPLETED
      )
      if (scenario === 'input') {
        assert.match(JSON.stringify(finished.artifacts), /Ada/)
      }
      assert.equal((await client.api.sessions.runs({ params: { id: current.id }, query: {} })).items.length, 1)
      await assert.rejects(
        a2a.resubscribeTask({ id: taskId, tenant: '' }).next(),
        (error: unknown) =>
          error instanceof Error &&
          error.cause instanceof Error &&
          'reason' in error.cause &&
          error.cause.reason === 'UNSUPPORTED_OPERATION'
      )
      await assert.rejects(
        a2a.sendMessage(
          SendMessageRequest.fromJSON({
            message: {
              contextId: current.id,
              messageId: randomUUID(),
              parts: [{ text: 'cannot reopen' }],
              role: 'ROLE_USER',
              taskId
            }
          })
        ),
        { name: 'UnsupportedOperationError' }
      )
      await verifyEffects(scenario === 'approve')
      console.log(`VERIFIED native-deterministic A2A: ${scenario}, same Task/Run, terminal rules, tool effects`)
    }

    for (const scenario of ['input', 'approve', 'deny', 'cancel'] as const) {
      const current = await session()
      const { runId } = await client.submit(current.id, `native-smoke:${scenario}`)
      let handled = false
      let cancelling: Promise<unknown> | undefined
      const result = await client.watch(runId, {
        input: (request) => {
          assert.equal(scenario, 'input')
          assert.equal(request.questions[0]?.id, 'name')
          handled = true
          return Promise.resolve({ name: ['Ada'] })
        },
        signal: AbortSignal.timeout(30000),
        ...(scenario === 'cancel'
          ? {}
          : {
              approval: () => {
                assert.ok(scenario === 'approve' || scenario === 'deny')
                handled = true
                return Promise.resolve(scenario)
              }
            }),
        onEvent: (event) => {
          if (
            scenario === 'cancel' &&
            event.type === 'CUSTOM' &&
            event.name === 'runtime.approval.requested' &&
            !handled
          ) {
            handled = true
            cancelling = client.cancel(runId)
            void cancelling.catch(() => {})
          }
        }
      })
      await cancelling
      assert.ok(handled, `${scenario} did not invoke native interaction callback`)
      assert.equal(result.terminal.type, scenario === 'cancel' ? 'RUN_ERROR' : 'RUN_FINISHED')
      assert.equal(
        (await client.api.runs.get({ params: { id: runId } })).status,
        scenario === 'cancel' ? 'cancelled' : 'succeeded'
      )
      if (scenario === 'input') {
        assert.match(JSON.stringify(result.messages), /Ada/)
      }
      await verifyEffects(scenario === 'approve')
      console.log(`VERIFIED native-deterministic TanStack: ${scenario}, typed interaction and tool effects`)
    }
    assert.ok(requests >= 14)
    console.log(
      'UNVERIFIED: hosted-model behavior; these are real Nitro/DSH/tool executions with deterministic local model responses.'
    )
  } finally {
    try {
      await server?.close()
    } finally {
      provider.closeAllConnections()
      await new Promise<void>((resolve) => provider.close(() => resolve()))
      await rm(directory, { force: true, recursive: true })
    }
  }
}

if (process.env.RUN_NATIVE_PROTOCOL_SMOKE === '1') {
  await main()
} else {
  console.log('SKIPPED: set RUN_NATIVE_PROTOCOL_SMOKE=1 to run native deterministic A2A/TanStack smoke.')
}
