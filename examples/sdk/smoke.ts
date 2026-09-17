// biome-ignore-all lint/suspicious/noMisplacedAssertion: Standalone opt-in smoke assertions.
// biome-ignore-all lint/suspicious/noConsole: CLI output is the example interface.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline/promises'

const model = process.env.CODEX_MODEL
if (process.env.RUN_CODEX_SMOKE !== '1' || !model) {
  console.log('SKIPPED: real Codex smoke not run')
} else {
  const [{ RuntimeManager }, { CodexRuntime }] = await Promise.all([
    import('@qingshaner/runtime'),
    import('@qingshaner/runtime-codex')
  ])
  const directory = await mkdtemp(join(tmpdir(), 'codex-sdk-smoke-'))
  const cwd = join(directory, 'workspace')
  const dataDir = join(directory, 'data')
  const codexHome = process.env.CODEX_HOME ?? join(homedir(), '.codex')
  await mkdir(cwd)
  const open = () => RuntimeManager.open({ dataDir, runtimes: [new CodexRuntime({ codexHome, model })] })
  let manager: import('@qingshaner/runtime').RuntimeManager | undefined
  const terminal = process.stdin.isTTY ? createInterface({ input: process.stdin, output: process.stdout }) : undefined
  try {
    manager = await open()
    await manager.createProject({ id: 'smoke', name: 'Smoke', workingDirectories: [cwd] })
    const session = await manager.createSession({ cwd, model, projectId: 'smoke', runtime: 'codex' })
    const { runId } = await manager.run(session.id, { text: 'Without tools, count from one to twenty.' })
    const iterator = manager.subscribe(runId)[Symbol.asyncIterator]()
    const first = await iterator.next()
    assert.equal(first.done, false)
    await iterator.return?.()
    const replay = await Array.fromAsync(manager.subscribe(runId, { afterSequence: first.value.sequence }))
    const full = await Array.fromAsync(manager.subscribe(runId))
    assert.deepEqual(full, [first.value, ...replay])
    assert.deepEqual(
      full.map(({ sequence }) => sequence),
      full.map((_, index) => index + 1)
    )
    assert.equal((await manager.getRun(runId)).status, 'succeeded')
    await manager.dispose()
    manager = await open()
    const resumed = await manager.resumeSession(session.id)
    assert.equal(resumed.id, session.id)
    assert.equal(resumed.nativeSessionId, session.nativeSessionId)
    console.log('VERIFIED: text replay, ordered cursor reconnection, persisted public session resume')

    if (!terminal) {
      console.log('UNVERIFIED: approval and cancellation require an interactive terminal')
    } else {
      const restricted = await manager.createSession({
        cwd,
        model,
        options: { sandbox: 'read-only' },
        projectId: 'smoke',
        runtime: 'codex'
      })
      const approvalRun = await manager.run(restricted.id, {
        text: 'Write the word smoke into smoke.txt in this directory. Request approval to write outside the read-only sandbox.'
      })
      let approvals = 0
      for await (const envelope of manager.subscribe(approvalRun.runId)) {
        console.log(JSON.stringify(envelope))
        if (envelope.event.type === 'CUSTOM' && envelope.event.name === 'runtime.approval.requested') {
          for (const approval of await manager.listPendingApprovals(approvalRun.runId)) {
            console.log(approval.detail)
            const decision =
              (await terminal.question('Type approve for this action, or anything else to deny: ')).trim() === 'approve'
                ? 'approve'
                : 'deny'
            await manager.respondApproval(approvalRun.runId, approval.id, decision)
            approvals++
          }
        }
      }
      console.log(
        approvals ? `VERIFIED: ${approvals} approval response(s)` : 'UNVERIFIED: model did not request approval'
      )

      const cancellationRun = await manager.run(session.id, {
        text: 'Without tools, write a numbered list of 10000 distinct short descriptions of trees.'
      })
      const cancellationManager = manager
      let cancellation: Promise<void> | undefined
      const onLine = (line: string) => {
        if (line.trim() === 'cancel' && !cancellation) {
          cancellation = cancellationManager.cancel(cancellationRun.runId)
          // Observe rejection immediately while the event stream continues to its terminal state.
          void cancellation.catch(() => {})
        }
      }
      terminal.on('line', onLine)
      console.log('Type cancel and press Enter while output is streaming to test cancellation.')
      try {
        for await (const envelope of manager.subscribe(cancellationRun.runId)) {
          console.log(JSON.stringify(envelope))
        }
        await cancellation
        const result = await manager.getRun(cancellationRun.runId)
        console.log(
          cancellation && result.status === 'cancelled'
            ? 'VERIFIED: explicit cancellation reached terminal state'
            : 'UNVERIFIED: cancellation was not requested in time or did not reach cancelled'
        )
      } finally {
        terminal.off('line', onLine)
      }
    }
  } finally {
    terminal?.close()
    try {
      await manager?.dispose()
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  }
}
