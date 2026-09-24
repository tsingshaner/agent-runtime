// biome-ignore-all lint/suspicious/noConsole: CLI output is the example interface.
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { setTimeout as delay } from 'node:timers/promises'

import { Knowledge } from '@qingshaner/knowledge'
import { Mcp } from '@qingshaner/mcp'
import { ProjectMemory } from '@qingshaner/memory'
import { ProjectResources, RuntimeManager } from '@qingshaner/runtime'
import { CodexRuntime } from '@qingshaner/runtime-codex'
import { DeepAgentsRuntime } from '@qingshaner/runtime-deepagents'
import { DshRuntime } from '@qingshaner/runtime-dsh'
import { Skills } from '@qingshaner/skill'

const runtime = process.env.RUNTIME ?? 'codex'
if (runtime !== 'codex' && runtime !== 'dsh' && runtime !== 'deepagents') {
  throw new Error('RUNTIME must be codex, dsh or deepagents')
}
const model = process.env.RUNTIME_MODEL ?? (runtime === 'codex' ? process.env.CODEX_MODEL : undefined)
if (!model) {
  throw new Error('Set RUNTIME_MODEL explicitly (or CODEX_MODEL for Codex)')
}
const dataDir = resolve(process.env.RUNTIME_DATA_DIR ?? '.agent-runtime')
const projectId = process.env.PROJECT_ID ?? 'demo'
const knowledge = await Knowledge.open(join(dataDir, 'resources/knowledge'))
const skills = await Skills.open(join(dataDir, 'resources/skills'))
const mcp = await Mcp.open(join(dataDir, 'resources/mcp'))
const resources = new ProjectResources({ knowledge, mcp, skills })
const manager = await RuntimeManager.open({
  dataDir,
  memory: process.env.MEMORY_ENDPOINT
    ? new ProjectMemory({
        apiKeyEnv: 'MEMORY_API_KEY',
        endpoint: process.env.MEMORY_ENDPOINT,
        serviceId: process.env.MEMORY_SERVICE_ID ?? 'agent-runtime'
      })
    : undefined,
  resources,
  runtimes: [
    new CodexRuntime({ dataDir: join(dataDir, 'codex') }),
    new DshRuntime({ baseURL: process.env.DSH_BASE_URL, dataDir: join(dataDir, 'dsh') }),
    new DeepAgentsRuntime({
      apiKeyEnv: process.env.DEEPAGENTS_API_KEY_ENV,
      baseUrl: process.env.DEEPAGENTS_BASE_URL,
      dataDir: join(dataDir, 'deepagents')
    })
  ]
})
const terminal = process.stdin.isTTY ? createInterface({ input: process.stdin, output: process.stdout }) : undefined
let activeRunId: string | undefined
const interrupted = new AbortController()
const stop = () => {
  interrupted.abort()
  if (activeRunId) {
    void manager.cancel(activeRunId).catch(() => console.error('Cancellation could not be confirmed'))
  }
  terminal?.close()
}
process.on('SIGINT', stop)
terminal?.on('SIGINT', stop)
try {
  try {
    await manager.getProject(projectId)
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'PROJECT_NOT_FOUND')) {
      throw error
    }
    await manager.createProject({ id: projectId, name: projectId, workingDirectories: [process.cwd()] })
  }
  await manager.updateProjectResources(projectId, async () => {
    if (process.env.KNOWLEDGE_DIR) {
      await knowledge.bind(projectId, resolve(process.env.KNOWLEDGE_DIR))
    }
    if (process.env.SKILL_ID) {
      await skills.bind(projectId, process.env.SKILL_ID, true)
    }
    if (process.env.MCP_ID) {
      await mcp.bind(projectId, process.env.MCP_ID, true)
    }
  })
  if (process.env.SESSION_ID) {
    const existing = await manager.getSession(process.env.SESSION_ID)
    if (existing.runtime !== runtime || existing.projectId !== projectId || existing.model !== model) {
      throw new Error('SESSION_ID must match the selected project, runtime and model')
    }
  }
  const session = process.env.SESSION_ID
    ? await manager.resumeSession(process.env.SESSION_ID)
    : await manager.createSession({ cwd: process.cwd(), model, projectId, runtime })
  console.log({ runtime: session.runtime, sessionId: session.id })
  interrupted.signal.throwIfAborted()
  const { runId } = await manager.run(session.id, {
    requestId: process.env.REQUEST_ID,
    text: process.env.PROMPT ?? 'Briefly describe this directory.'
  })
  activeRunId = runId
  interrupted.signal.throwIfAborted()
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
            answers[question.id] = [await terminal.question(`${question.question} `, { signal: interrupted.signal })]
          }
          await manager.respondInput(runId, input.id, answers)
        }
      }
    }
    if (envelope.event.type === 'CUSTOM' && envelope.event.name === 'runtime.approval.requested') {
      for (const approval of await manager.listPendingApprovals(runId)) {
        if (approval.status !== 'pending') {
          continue
        }
        console.log({ approval: approval.detail, kind: approval.kind })
        const answer = terminal
          ? await terminal.question('Approve this operation? [y/N] ', { signal: interrupted.signal })
          : ''
        await manager.respondApproval(runId, approval.id, answer.toLowerCase() === 'y' ? 'approve' : 'deny')
      }
    }
  }
  activeRunId = undefined
  console.log(await manager.getRun(runId))
  // A successful chat can precede the remote write receipt; never retry uncertain writes.
  let write = await manager.getMemoryWrite(runId)
  const deadline = Date.now() + 6000
  while (write && ['pending', 'unknown'].includes(write.status) && Date.now() < deadline) {
    await delay(100)
    write = await manager.getMemoryWrite(runId)
  }
  console.log({ memoryWrite: write })
} catch (error) {
  if (!interrupted.signal.aborted) {
    throw error
  }
  console.log('Cancellation requested; closing owned runtime resources.')
} finally {
  process.off('SIGINT', stop)
  terminal?.off('SIGINT', stop)
  terminal?.close()
  await manager.dispose().finally(() => mcp.dispose())
}
