// biome-ignore-all lint/suspicious/noConsole: CLI output is the example interface.
import { RuntimeManager } from '@qingshaner/runtime'
import { CodexRuntime } from '@qingshaner/runtime-codex'

const model = process.env.CODEX_MODEL
if (!model) {
  throw new Error('Set CODEX_MODEL before running this example')
}
const manager = await RuntimeManager.open({
  dataDir: './.agent-runtime',
  runtimes: [new CodexRuntime({ model })]
})
try {
  const session = process.env.SESSION_ID
    ? await manager.resumeSession(process.env.SESSION_ID)
    : await manager.createSession({ cwd: process.cwd(), projectId: 'demo', runtime: 'codex' })
  console.log({ sessionId: session.id })
  const { runId } = await manager.run(session.id, { text: 'Briefly describe this directory.' })
  for await (const envelope of manager.subscribe(runId)) {
    console.log(JSON.stringify(envelope))
    if (envelope.event.type === 'CUSTOM' && envelope.event.name === 'runtime.approval.requested') {
      for (const approval of await manager.listPendingApprovals(runId)) {
        await manager.respondApproval(runId, approval.id, 'deny')
      }
    }
  }
  console.log(await manager.getRun(runId))
} finally {
  await manager.dispose()
}
