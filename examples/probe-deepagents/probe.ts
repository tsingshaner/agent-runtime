// cspell:ignore langgraph checkpointer HITL
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout } from 'node:timers/promises'

import { BaseChatModel } from '@langchain/core/language_models/chat_models'
import { AIMessage, type BaseMessage, ToolMessage } from '@langchain/core/messages'
import { Command, interrupt } from '@langchain/langgraph'
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite'
import { createDeepAgent } from 'deepagents'
import { createMiddleware, tool } from 'langchain'
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

const [mode, dir, decisionsJson] = process.argv.slice(2)
if (!(dir && ['batch', 'approve', 'pause', 'inspect', 'new', 'cancel', 'resume', 'native'].includes(mode ?? ''))) {
  throw new Error('Usage: node probe.ts <batch|approve|pause|inspect|new|cancel|resume|native> <data-directory>')
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
// Official extension hooks preserve every call until the tool boundary. The built-in
// HITL middleware drops approved calls in mixed batches in langchain 1.5.11.
const decisionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('approve') }).strict(),
  z.object({ message: z.string().optional(), type: z.literal('reject') }).strict()
])
const batchApproval = createMiddleware({
  afterModel: async (state) => {
    const message = state.messages.at(-1)
    const calls = AIMessage.isInstance(message)
      ? (message.tool_calls ?? []).filter((call) => call.name === 'record_effect')
      : []
    if (calls.length === 0) {
      return { approvalBatch: [] }
    }
    const ids = calls.map((call) => z.string().min(1).parse(call.id))
    if (new Set(ids).size !== ids.length) {
      throw new Error('Duplicate approval action ID')
    }
    const response = await interrupt({
      actionRequests: calls.map((call) => ({ args: call.args, name: call.name })),
      reviewConfigs: calls.map((call) => ({ actionName: call.name, allowedDecisions: ['approve', 'reject'] }))
    })
    const { decisions } = z
      .object({ decisions: z.array(decisionSchema).length(calls.length) })
      .strict()
      .parse(response)
    return { approvalBatch: ids.map((id, index) => ({ decision: decisions[index], id })) }
  },
  name: 'ProbeBatchApproval',
  stateSchema: z.object({
    approvalBatch: z.array(z.object({ decision: decisionSchema, id: z.string() })).default([])
  }),
  wrapToolCall: (request, handler) => {
    if (request.toolCall.name !== 'record_effect') {
      return handler(request)
    }
    const approval = request.state.approvalBatch.find((item) => item.id === request.toolCall.id)
    if (!approval) {
      throw new Error('Missing approval for tool call')
    }
    if (approval.decision.type === 'approve') {
      return handler(request)
    }
    return new ToolMessage({
      content: approval.decision.message ?? 'User rejected the tool call',
      name: request.toolCall.name,
      status: 'error',
      // biome-ignore lint/style/useNamingConvention: Native LangChain message field.
      tool_call_id: approval.id
    })
  }
})
const agent = createDeepAgent({
  checkpointer,
  // biome-ignore lint/style/useNamingConvention: Native tool name.
  interruptOn: mode === 'native' ? { record_effect: { allowedDecisions: ['approve', 'reject'] } } : undefined,
  middleware: mode === 'native' ? [] : [batchApproval],
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
      const approvalSnapshots = []
      for await (const snapshot of agent.graph.getStateHistory(config)) {
        if (snapshot.values.approvalBatch?.length) {
          approvalSnapshots.push(snapshot.values.approvalBatch)
        }
      }
      output = { approvalSnapshots, interrupts, pending: state.next.length }
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
    if (mode !== 'resume') {
      await agent.invoke({ messages: [{ content: 'batch', role: 'user' }] }, config)
    }
    const state = await agent.graph.getState(config)
    const interrupts = state.tasks.flatMap((task) => task.interrupts ?? [])
    if (mode === 'resume' && interrupts.length !== 1) {
      throw new Error('No pending approval batch')
    }
    if (mode === 'pause') {
      output = { interrupts, pending: state.next.length }
    } else {
      const result = await agent.invoke(
        new Command({
          resume: {
            decisions: decisionsJson
              ? JSON.parse(decisionsJson)
              : [
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
