// cspell:ignore langgraph HITL
import { AIMessage, ToolMessage } from '@langchain/core/messages'
import { interrupt } from '@langchain/langgraph'
import { createMiddleware, tool } from 'langchain'
import { z } from 'zod'

const decision = z.discriminatedUnion('type', [
  z.object({ type: z.literal('approve') }),
  z.object({ message: z.string().optional(), type: z.literal('reject') })
])
export const nativeInteraction = z.discriminatedUnion('kind', [
  z.object({
    calls: z.array(z.object({ args: z.record(z.string(), z.json()), id: z.string(), name: z.string() })).min(1),
    kind: z.literal('approval')
  }),
  z.object({
    kind: z.literal('input'),
    questions: z.array(z.object({ header: z.string(), id: z.string(), question: z.string() })).min(1)
  })
])

// The pinned built-in HITL middleware drops approved calls in mixed batches.
// Preserve native calls and enforce each decision at the actual tool boundary.
export const approvalMiddleware = (names: Set<string>) =>
  createMiddleware({
    afterModel: async (state) => {
      const message = state.messages.at(-1)
      const calls = AIMessage.isInstance(message)
        ? (message.tool_calls ?? []).filter((call) => names.has(call.name))
        : []
      if (calls.length === 0) {
        return { runtimeDecisions: [] }
      }
      const ids = calls.map((call) => z.string().min(1).parse(call.id))
      if (new Set(ids).size !== ids.length) {
        throw new Error('Duplicate native tool identity')
      }
      const response = await interrupt({ calls, kind: 'approval' })
      const { decisions } = z
        .object({ decisions: z.array(decision).length(calls.length) })
        .strict()
        .parse(response)
      return { runtimeDecisions: ids.map((id, index) => ({ decision: decision.parse(decisions[index]), id })) }
    },
    name: 'RuntimeApproval',
    stateSchema: z.object({ runtimeDecisions: z.array(z.object({ decision, id: z.string() })).default([]) }),
    wrapToolCall: (request, handler) => {
      if (!names.has(request.toolCall.name)) {
        return handler(request)
      }
      const approval = request.state.runtimeDecisions.find((item) => item.id === request.toolCall.id)
      if (!approval) {
        throw new Error('Missing tool approval')
      }
      if (approval.decision.type === 'approve') {
        return handler(request)
      }
      return new ToolMessage({
        content: 'User rejected the tool call',
        name: request.toolCall.name,
        status: 'error',
        // biome-ignore lint/style/useNamingConvention: Native LangChain field.
        tool_call_id: approval.id
      })
    }
  })

export const inputTool = tool(async ({ questions }) => JSON.stringify(await interrupt({ kind: 'input', questions })), {
  description: 'Ask the user for missing information and wait for their answers.',
  name: 'ask_user',
  schema: z.object({
    questions: z.array(z.object({ header: z.string(), id: z.string().min(1), question: z.string().min(1) })).min(1)
  })
})

/** Track tool completion beyond LangGraph's abort race before confirming cancellation. */
export const executionMiddleware = (pending: Set<Promise<unknown>>) =>
  createMiddleware({
    name: 'RuntimeToolCompletion',
    wrapToolCall: (request, handler) => {
      const result = Promise.resolve().then(() => handler(request))
      pending.add(result)
      void result.finally(() => pending.delete(result)).catch(() => {})
      return result
    }
  })

export const trackedTool = (spec: import('./index').DeepAgentsTool, pending: Set<Promise<unknown>>) =>
  tool(
    (args, config) => {
      const result = Promise.resolve().then(() => spec.execute(args, config.signal ?? new AbortController().signal))
      pending.add(result)
      void result.finally(() => pending.delete(result)).catch(() => {})
      return result
    },
    { description: spec.description, name: spec.name, schema: spec.schema }
  )
