// cspell:ignore langgraph checkpointer
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout } from 'node:timers/promises'

import { BaseChatModel } from '@langchain/core/language_models/chat_models'
import { AIMessage, type BaseMessage } from '@langchain/core/messages'
import { Command } from '@langchain/langgraph'
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite'
import { createDeepAgent } from 'deepagents'
import { tool } from 'langchain'
import { z } from 'zod'

// Explicit deterministic model fixture; graph, approval middleware and SQLite are real.
class ProbeModel extends BaseChatModel {
  _llmType() {
    return 'deterministic-probe'
  }
  bindTools() {
    return this
  }
  _generate(messages: BaseMessage[]) {
    const last = messages.at(-1)
    const request = last?.type === 'human' ? last.content : ''
    const calls =
      request === 'batch'
        ? ['approved', 'rejected'].map((label) => ({
            args: { label },
            id: label,
            name: 'record_effect',
            type: 'tool_call' as const
          }))
        : request === 'cancel'
          ? [{ args: {}, id: 'slow', name: 'slow_effect', type: 'tool_call' as const }]
          : []
    // biome-ignore lint/style/useNamingConvention: Native LangChain message field.
    const message = new AIMessage({ content: calls.length > 0 ? '' : 'Done', tool_calls: calls })
    return Promise.resolve({ generations: [{ message, text: String(message.content) }] })
  }
}

const [mode, dir] = process.argv.slice(2)
if (!(dir && ['batch', 'approve', 'pause', 'inspect', 'new', 'cancel'].includes(mode ?? ''))) {
  throw new Error('Usage: node probe.ts <batch|approve|pause|inspect|new|cancel> <data-directory>')
}
await mkdir(dir, { recursive: true })
const effectsFile = join(dir, 'effects.jsonl')
const effects = async (): Promise<string[]> => {
  try {
    return (await readFile(effectsFile, 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return []
    }
    throw error
  }
}
const checkpointer = SqliteSaver.fromConnString(join(dir, 'checkpoint.sqlite'))
const controller = new AbortController()
let toolStopped = false
const slowStarted = Promise.withResolvers<void>()
const slowStopped = Promise.withResolvers<void>()
const record = tool(
  async ({ label }) => {
    await appendFile(effectsFile, `${JSON.stringify(label)}\n`)
    return `Recorded ${label}`
  },
  { description: 'Record one observable effect.', name: 'record_effect', schema: z.object({ label: z.string() }) }
)
const slow = tool(
  async (_, config) => {
    slowStarted.resolve()
    try {
      await setTimeout(60000, undefined, { signal: config.signal })
      await appendFile(effectsFile, '"unsafe"\n')
      return 'Recorded unsafe'
    } finally {
      toolStopped = true
      slowStopped.resolve()
    }
  },
  { description: 'Wait before recording an effect.', name: 'slow_effect', schema: z.object({}) }
)
const agent = createDeepAgent({
  checkpointer,
  // biome-ignore lint/style/useNamingConvention: Native tool name.
  interruptOn: { record_effect: { allowedDecisions: ['approve', 'reject'] } },
  model: new ProbeModel({}),
  tools: [record, slow]
})
// biome-ignore lint/style/useNamingConvention: Native LangGraph thread key.
const config = { configurable: { thread_id: 'probe-session' }, durability: 'sync' as const }
try {
  let output: Record<string, unknown>
  if (mode === 'new' || mode === 'inspect') {
    const state = await agent.graph.getState(config)
    const interrupts = state.tasks.flatMap((task) => task.interrupts ?? [])
    if (mode === 'inspect') {
      output = { interrupts, pending: state.next.length }
    } else if (
      !state.createdAt ||
      state.next.length > 0 ||
      state.tasks.some((task) => task.error || task.interrupts?.length)
    ) {
      output = { status: 'unsafe_resume' }
    } else {
      await agent.invoke({ messages: [{ content: 'fresh', role: 'user' }] }, config)
      output = { status: 'completed' }
    }
  } else if (mode === 'cancel') {
    const running = agent.invoke(
      { messages: [{ content: 'cancel', role: 'user' }] },
      { ...config, signal: controller.signal }
    )
    // Attach the rejection handler before requesting cancellation.
    const settled = running.then(
      () => false,
      () => true
    )
    await slowStarted.promise
    controller.abort(new Error('probe cancellation'))
    const aborted = await settled
    await slowStopped.promise
    output = { status: aborted ? 'cancelled' : 'unexpected_completion', toolStopped }
  } else {
    await agent.invoke({ messages: [{ content: 'batch', role: 'user' }] }, config)
    const state = await agent.graph.getState(config)
    const interrupts = state.tasks.flatMap((task) => task.interrupts ?? [])
    if (mode === 'pause') {
      output = { interrupts, pending: state.next.length }
    } else {
      const result = await agent.invoke(
        new Command({
          resume: {
            decisions: [
              { type: 'approve' },
              mode === 'approve' ? { type: 'approve' } : { message: 'Probe rejects this operation', type: 'reject' }
            ]
          }
        }),
        config
      )
      const after = await agent.graph.getState(config)
      const batch = interrupts[0]?.value as { actionRequests: { args: { label: string } }[] }
      output = {
        actions: batch.actionRequests.map((action) => action.args.label),
        pending: after.next.length,
        rejectionObserved: result.messages.some(
          (message) => message.type === 'tool' && String(message.content).includes('Probe rejects this operation')
        ),
        status:
          mode === 'approve'
            ? 'completed'
            : (await effects()).includes('approved')
              ? 'mixed_batch_supported'
              : 'mixed_batch_unsupported'
      }
    }
  }
  process.stdout.write(
    `${JSON.stringify({
      ...output,
      effects: await effects(),
      model: 'deterministic fixture; hosted model UNVERIFIED',
      pid: process.pid
    })}\n`
  )
} finally {
  checkpointer.db.close()
}
