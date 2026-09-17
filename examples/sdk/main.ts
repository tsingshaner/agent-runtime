// biome-ignore-all lint/suspicious/noConsole: CLI output is the example interface.
import { createInterface } from 'node:readline/promises'

import { RuntimeManager } from '@qingshaner/runtime'
import { CodexRuntime } from '@qingshaner/runtime-codex'

const model = process.env.CODEX_MODEL
if (!model) {
  throw new Error('Set CODEX_MODEL before running this example')
}
const manager = await RuntimeManager.open({
  dataDir: './.agent-runtime',
  runtimes: [new CodexRuntime({ dataDir: './.agent-runtime/codex' })]
})
const terminal = process.stdin.isTTY ? createInterface({ input: process.stdin, output: process.stdout }) : undefined
try {
  try {
    await manager.getProject('demo')
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'PROJECT_NOT_FOUND')) {
      throw error
    }
    await manager.createProject({ id: 'demo', name: 'Demo', workingDirectories: [process.cwd()] })
  }
  const session = process.env.SESSION_ID
    ? await manager.resumeSession(process.env.SESSION_ID)
    : await manager.createSession({ cwd: process.cwd(), model, projectId: 'demo', runtime: 'codex' })
  console.log({ sessionId: session.id })
  const { runId } = await manager.run(session.id, {
    requestId: process.env.REQUEST_ID,
    text: 'Briefly describe this directory.'
  })
  for await (const envelope of manager.subscribe(runId)) {
    console.log(JSON.stringify(envelope))
    if (envelope.event.type === 'CUSTOM' && envelope.event.name === 'runtime.input.requested') {
      if (!terminal) {
        await manager.cancel(runId)
      } else {
        for (const input of await manager.listPendingInputs(runId)) {
          if (input.questions.some((question) => question.isSecret)) {
            console.log('This example does not support hidden input; cancelling the run.')
            await manager.cancel(runId)
            break
          }
          const answers: Record<string, string[]> = {}
          for (const question of input.questions) {
            answers[question.id] = [await terminal.question(`${question.question} `)]
          }
          await manager.respondInput(runId, input.id, answers)
        }
      }
    }
    if (envelope.event.type === 'CUSTOM' && envelope.event.name === 'runtime.approval.requested') {
      for (const approval of await manager.listPendingApprovals(runId)) {
        await manager.respondApproval(runId, approval.id, 'deny')
      }
    }
  }
  console.log(await manager.getRun(runId))
} finally {
  terminal?.close()
  await manager.dispose()
}
