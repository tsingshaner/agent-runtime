// cspell:ignore langgraph checkpointer
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import { AIMessage, type BaseMessage } from '@langchain/core/messages'
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite'
import { ChatOpenAI } from '@langchain/openai'
import { RuntimeError } from '@qingshaner/runtime'
import { createDeepAgent } from 'deepagents'

import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { StructuredToolInterface } from '@langchain/core/tools'
import type {
  AdapterNotice,
  AdapterOutcome,
  ApprovalDecision,
  NativeSession,
  RuntimeAdapter
} from '@qingshaner/runtime'

import { Events } from './events'

export interface DeepAgentsOptions {
  dataDir: string
  baseUrl?: string
  apiKeyEnv?: string
  /** Caller-owned provider configuration; credentials are never persisted in sessions. */
  model?: (name: string) => BaseChatModel
  tools?: StructuredToolInterface[]
}

/** Native graph state belongs to this adapter; the Manager owns public run state. */
export class DeepAgentsRuntime implements RuntimeAdapter {
  readonly kind = 'deepagents' as const
  #saver?: SqliteSaver
  #disposed = false
  readonly #runs = new Map<string, { controller: AbortController; done: Promise<void> }>()
  constructor(readonly options: DeepAgentsOptions) {}

  async #graph(session: NativeSession) {
    if (this.#disposed) {
      throw new RuntimeError('DISPOSED', 'Deep Agents disposed')
    }
    if (!session.model) {
      throw new RuntimeError('INVALID_INPUT', 'Deep Agents requires a model')
    }
    if (!this.#saver) {
      await mkdir(this.options.dataDir, { recursive: true })
      this.#saver ??= SqliteSaver.fromConnString(join(this.options.dataDir, 'checkpoints.sqlite'))
    }
    return createDeepAgent({
      checkpointer: this.#saver,
      model:
        this.options.model?.(session.model) ??
        new ChatOpenAI({
          apiKey: process.env[this.options.apiKeyEnv ?? 'OPENAI_API_KEY'],
          configuration: { baseURL: this.options.baseUrl },
          model: session.model.replace(/^openai:/, '')
        }),
      subagents: [],
      tools: this.options.tools ?? []
    })
  }
  #config(session: NativeSession) {
    // biome-ignore lint/style/useNamingConvention: Native LangGraph key.
    return { configurable: { thread_id: session.nativeSessionId }, durability: 'sync' as const }
  }
  async createSession(input: {
    cwd: string
    model?: string
    projectId?: string
    options?: Record<string, never>
  }): Promise<NativeSession> {
    const session = { ...input, nativeSessionId: randomUUID(), options: input.options ?? {} }
    const agent = await this.#graph(session)
    await agent.graph.updateState(this.#config(session), null)
    return session
  }
  async resumeSession(session: NativeSession) {
    const agent = await this.#graph(session)
    const state = await agent.graph.getState(this.#config(session))
    if (!state.createdAt) {
      throw new RuntimeError('NATIVE_SESSION_MISSING', 'Deep Agents checkpoint missing')
    }
    if (state.next.length > 0 || state.tasks.some((task) => task.error || task.interrupts?.length)) {
      throw new RuntimeError('UNSAFE_RESUME', 'Deep Agents checkpoint contains unfinished work')
    }
  }
  async execute(
    session: NativeSession,
    input: { sessionId: string; runId: string; text: string; context?: string },
    emit: (notice: AdapterNotice) => Promise<void>
  ): Promise<AdapterOutcome> {
    const controller = new AbortController()
    const done = Promise.withResolvers<void>()
    this.#runs.set(input.runId, { controller, done: done.promise })
    try {
      const agent = await this.#graph(session)
      const config = {
        ...this.#config(session),
        signal: controller.signal,
        streamMode: ['messages', 'updates'] as ['messages', 'updates']
      }
      await emit({ kind: 'started', nativeTurnId: input.runId })
      const stream = await agent.graph.stream(
        { messages: [{ content: input.context ? `${input.context}\n\n${input.text}` : input.text, role: 'user' }] },
        config
      )
      const events = new Events(input.runId, emit)
      for await (const [mode, value] of stream) {
        if (mode === 'messages') {
          await events.message((value as [BaseMessage, unknown])[0])
        } else {
          await events.update(value as Record<string, { messages?: BaseMessage[] }>)
        }
      }
      await events.end()
      const state = await agent.graph.getState(config)
      if (state.next.length > 0) {
        throw new RuntimeError('UNSUPPORTED_INTERACTION', 'Native execution requires unsupported interaction')
      }
      const last = state.values.messages?.at(-1)
      return {
        finalReply: AIMessage.isInstance(last) && typeof last.content === 'string' ? last.content : '',
        status: 'succeeded'
      }
    } catch (error) {
      if (controller.signal.aborted) {
        return { status: 'cancelled' }
      }
      throw error
    } finally {
      this.#runs.delete(input.runId)
      done.resolve()
    }
  }
  async cancel(runId: string) {
    this.#runs.get(runId)?.controller.abort()
  }
  async respondApproval(_runId: string, _nativeRequestId: string | number, _decision: ApprovalDecision): Promise<void> {
    throw new RuntimeError('UNSUPPORTED_INTERACTION', 'Use native batch approval')
  }
  async dispose() {
    this.#disposed = true
    for (const run of this.#runs.values()) {
      run.controller.abort()
    }
    await Promise.all([...this.#runs.values()].map((run) => run.done))
    this.#saver?.db.close()
    this.#saver = undefined
  }
}
