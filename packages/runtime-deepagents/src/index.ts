// cspell:ignore langgraph checkpointer
import { randomUUID } from 'node:crypto'
import { access, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout } from 'node:timers/promises'

import { AIMessage, type BaseMessage } from '@langchain/core/messages'
import { Command } from '@langchain/langgraph'
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite'
import { ChatOpenAI } from '@langchain/openai'
import { RuntimeError } from '@qingshaner/runtime'
import { createDeepAgent } from 'deepagents'
import { z } from 'zod'

import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type {
  AdapterNotice,
  AdapterOutcome,
  ApprovalBatchDecision,
  ApprovalDecision,
  InputAnswers,
  NativeSession,
  ResourceSnapshot,
  RuntimeAdapter
} from '@qingshaner/runtime'

import { Events } from './events'
import { approvalMiddleware, executionMiddleware, inputTool, nativeInteraction, trackedTool } from './interactions'
import { filesystem, openResources } from './resources'

export interface DeepAgentsTool {
  name: string
  description: string
  schema: z.ZodObject
  execute: (args: Record<string, unknown>, signal: AbortSignal) => Promise<string> | string
}

export interface DeepAgentsOptions {
  dataDir: string
  baseUrl?: string
  apiKeyEnv?: string
  /** Caller-owned provider configuration; credentials are never persisted in sessions. */
  model?: (name: string) => BaseChatModel
  tools?: DeepAgentsTool[]
  approvalTools?: string[]
}

/** Native graph state belongs to this adapter; the Manager owns public run state. */
export class DeepAgentsRuntime implements RuntimeAdapter {
  readonly kind = 'deepagents' as const
  #saver?: SqliteSaver
  readonly #projects = new Map<string, ResourceSnapshot>()
  #disposed = false
  #opening?: Promise<SqliteSaver>
  #disposing?: Promise<void>
  readonly #tools = new Set<Promise<unknown>>()
  readonly #pending = new Map<
    string,
    { id: string; kind: 'approval' | 'input'; ids: string[]; respond: (value: unknown) => void }
  >()
  readonly #runs = new Map<string, { controller: AbortController; done: Promise<void> }>()
  constructor(readonly options: DeepAgentsOptions) {
    if (options.baseUrl) {
      const url = new URL(options.baseUrl)
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
        throw new RuntimeError('INVALID_INPUT', 'Invalid model base URL')
      }
    }
  }

  configureProject(projectId: string, snapshot: ResourceSnapshot): Promise<void> {
    if (this.#disposed) {
      return Promise.reject(new RuntimeError('DISPOSED', 'Deep Agents disposed'))
    }
    this.#projects.set(projectId, { ...snapshot, skillDirectories: [...snapshot.skillDirectories] })
    return Promise.resolve()
  }
  async #graph(session: NativeSession, pending = new Set<Promise<unknown>>(), resources: DeepAgentsTool[] = []) {
    if (this.#disposed) {
      throw new RuntimeError('DISPOSED', 'Deep Agents disposed')
    }
    if (!session.model) {
      throw new RuntimeError('INVALID_INPUT', 'Deep Agents requires a model')
    }
    if (!this.#saver) {
      this.#opening ??= mkdir(this.options.dataDir, { recursive: true }).then(() => {
        if (this.#disposed) {
          throw new RuntimeError('DISPOSED', 'Deep Agents disposed')
        }
        return SqliteSaver.fromConnString(join(this.options.dataDir, 'checkpoints.sqlite'))
      })
      this.#saver = await this.#opening
    }
    const tools = [...(this.options.tools ?? []), ...resources]
    const reserved = new Set([
      'ask_user',
      'ls',
      'read_file',
      'write_file',
      'edit_file',
      'glob',
      'grep',
      'execute',
      'task',
      'write_todos'
    ])
    for (const tool of tools) {
      if (reserved.has(tool.name)) {
        throw new RuntimeError('TOOL_CONFLICT', 'Project tool name conflicts with native tools')
      }
      reserved.add(tool.name)
    }
    return createDeepAgent({
      backend: filesystem(session.cwd, pending),
      checkpointer: this.#saver,
      middleware: [
        executionMiddleware(pending),
        approvalMiddleware(
          new Set(
            this.options.approvalTools ?? [
              ...tools
                .filter((tool) => !['knowledge_read', 'knowledge_search'].includes(tool.name))
                .map((tool) => tool.name),
              'write_file',
              'edit_file',
              'execute',
              'task'
            ]
          )
        )
      ],
      model:
        this.options.model?.(session.model) ??
        new ChatOpenAI({
          apiKey: process.env[this.options.apiKeyEnv ?? 'OPENAI_API_KEY'],
          configuration: { baseURL: this.options.baseUrl },
          model: session.model.replace(/^openai:/, '')
        }),
      skills: this.#projects.get(session.projectId ?? '')?.skillDirectories ?? [],
      subagents: [],
      tools: [...tools.map((spec) => trackedTool(spec, pending)), inputTool]
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
    if (
      !z
        .object({})
        .strict()
        .safeParse(input.options ?? {}).success
    ) {
      throw new RuntimeError('INVALID_INPUT', 'Unknown Deep Agents session options')
    }
    const session = { ...input, nativeSessionId: randomUUID(), options: input.options ?? {} }
    const agent = await this.#graph(session)
    await agent.graph.updateState(this.#config(session), null)
    return session
  }
  async resumeSession(session: NativeSession) {
    if (!z.string().uuid().safeParse(session.nativeSessionId).success) {
      throw new RuntimeError('NATIVE_SESSION_MISSING', 'Invalid native identity')
    }
    try {
      await access(join(this.options.dataDir, `${session.nativeSessionId}.active`))
      throw new RuntimeError('UNSAFE_RESUME', 'Previous native execution did not finish safely')
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
        throw error
      }
    }
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
    const pending = new Set<Promise<unknown>>()
    let resourceCancellationUnconfirmed = false
    let resources: Awaited<ReturnType<typeof openResources>> | undefined
    const marker = join(this.options.dataDir, `${session.nativeSessionId}.active`)
    try {
      resources = await openResources(this.#projects.get(session.projectId ?? ''), controller.signal, () => {
        resourceCancellationUnconfirmed = true
      })
      const agent = await this.#graph(session, pending, resources.tools)
      await writeFile(marker, input.runId, { flag: 'wx' })
      const config = {
        ...this.#config(session),
        signal: controller.signal,
        streamMode: ['messages', 'updates'] as ['messages', 'updates']
      }
      await emit({ kind: 'started', nativeTurnId: input.runId })
      let next: Parameters<typeof agent.graph.stream>[0] = {
        messages: [{ content: [input.context, input.text].filter(Boolean).join('\n\n'), role: 'user' }]
      }
      const previous = await agent.graph.getState(config)
      const events = new Events(
        input.runId,
        emit,
        new Set((previous.values.messages ?? []).flatMap((message: BaseMessage) => (message.id ? [message.id] : [])))
      )
      let resolved: { id: string; kind: 'approval' | 'input' } | undefined
      const streamRound = async (value: Parameters<typeof agent.graph.stream>[0]) => {
        const stream = await agent.graph.stream(value, config)
        for await (const [mode, value] of stream) {
          if (mode === 'messages') {
            await events.message((value as [BaseMessage, unknown])[0])
          } else {
            await events.update(value as Record<string, { messages?: BaseMessage[] }>)
          }
        }
      }
      for (;;) {
        await streamRound(next)
        await events.end()
        if (resolved) {
          await emit({
            kind: resolved.kind === 'approval' ? 'approval-batch-resolved' : 'input-resolved',
            nativeRequestId: resolved.id,
            responseAttempted: true
          })
        }
        const state = await agent.graph.getState(config)
        if (state.next.length === 0) {
          break
        }
        const response = await this.#waitInteraction(
          state.tasks.flatMap((task) => task.interrupts ?? []),
          input.runId,
          emit,
          controller.signal
        )
        next = response.command
        resolved = response.resolved
      }
      const state = await agent.graph.getState(config)
      await rm(marker)
      const last = state.values.messages?.at(-1)
      return this.#success(last)
    } catch (error) {
      return await this.#failure(error, controller.signal, pending, resourceCancellationUnconfirmed)
    } finally {
      await this.#finish(resources, pending, input.runId, done.resolve)
    }
  }
  async #failure(
    error: unknown,
    signal: AbortSignal,
    pending: Set<Promise<unknown>>,
    resourceCancellationUnconfirmed: boolean
  ): Promise<AdapterOutcome> {
    if (signal.aborted) {
      await this.#settleTools(pending)
      if (resourceCancellationUnconfirmed) {
        throw new RuntimeError('CANCELLATION_UNCONFIRMED', 'Remote tool cancellation was not confirmed')
      }
      return { status: 'cancelled' }
    }
    if (error instanceof RuntimeError) {
      throw error
    }
    throw new RuntimeError('DEEPAGENTS_ERROR', 'Native Deep Agents execution failed')
  }
  async #finish(
    resources: Awaited<ReturnType<typeof openResources>> | undefined,
    pending: Set<Promise<unknown>>,
    runId: string,
    resolve: () => void
  ) {
    await (resources?.close() ?? Promise.resolve()).finally(() => {
      for (const tool of pending) {
        this.#tools.add(tool)
        void tool.finally(() => this.#tools.delete(tool)).catch(() => {})
      }
      this.#runs.delete(runId)
      resolve()
    })
  }

  #success(last: unknown): AdapterOutcome {
    return {
      finalReply: AIMessage.isInstance(last) && typeof last.content === 'string' ? last.content : '',
      status: 'succeeded'
    }
  }
  async #waitInteraction(
    interrupts: { id?: string; value?: unknown }[],
    runId: string,
    emit: (notice: AdapterNotice) => Promise<void>,
    signal: AbortSignal
  ) {
    if (interrupts.length !== 1 || !interrupts[0]?.id) {
      throw new RuntimeError('UNSUPPORTED_INTERACTION', 'Unsupported native interrupt')
    }
    const native = interrupts[0]
    const request = nativeInteraction.parse(native.value)
    const response = Promise.withResolvers<unknown>()
    void response.promise.catch(() => {})
    const id = z.string().parse(native.id)
    this.#pending.set(runId, {
      id,
      ids: request.kind === 'approval' ? request.calls.map((call) => call.id) : [],
      kind: request.kind,
      respond: response.resolve
    })
    const aborted = () => response.reject(signal.reason)
    signal.addEventListener('abort', aborted, { once: true })
    try {
      if (request.kind === 'approval') {
        await emit({
          kind: 'approval-batch',
          request: {
            nativeRequestId: id,
            requests: request.calls.map((call) => ({
              allowedDecisions: ['approve', 'deny'],
              detail: { args: call.args, name: call.name },
              kind: 'tool',
              nativeRequestId: call.id
            }))
          }
        })
      } else {
        await emit({ kind: 'input', request: { nativeRequestId: id, questions: request.questions } })
      }
      signal.throwIfAborted()
      return {
        command: new Command({ resume: { [id]: await response.promise } }),
        resolved: { id, kind: request.kind }
      }
    } finally {
      signal.removeEventListener('abort', aborted)
      this.#pending.delete(runId)
    }
  }
  respondApprovalBatch(
    runId: string,
    nativeRequestId: string | number,
    decisions: ApprovalBatchDecision[]
  ): Promise<void> {
    const pending = this.#pending.get(runId)
    if (
      pending?.kind !== 'approval' ||
      pending.id !== nativeRequestId ||
      decisions.length !== pending.ids.length ||
      decisions.some((item, index) => item.nativeRequestId !== pending.ids[index])
    ) {
      return Promise.reject(new RuntimeError('INVALID_APPROVAL', 'Approval batch no longer pending'))
    }
    this.#pending.delete(runId)
    pending.respond({
      decisions: decisions.map((item) => (item.decision === 'approve' ? { type: 'approve' } : { type: 'reject' }))
    })
    return Promise.resolve()
  }
  respondInput(runId: string, nativeRequestId: string | number, answers: InputAnswers): Promise<void> {
    const pending = this.#pending.get(runId)
    if (pending?.kind !== 'input' || pending.id !== nativeRequestId) {
      return Promise.reject(new RuntimeError('INVALID_INPUT', 'Input no longer pending'))
    }
    this.#pending.delete(runId)
    pending.respond(answers)
    return Promise.resolve()
  }
  async cancel(runId: string) {
    this.#runs.get(runId)?.controller.abort()
  }
  async respondApproval(_runId: string, _nativeRequestId: string | number, _decision: ApprovalDecision): Promise<void> {
    throw new RuntimeError('UNSUPPORTED_INTERACTION', 'Use native batch approval')
  }
  async #settleTools(pending: Set<Promise<unknown>>) {
    const timer = new AbortController()
    try {
      await Promise.race([
        Promise.allSettled([...pending]),
        setTimeout(5000, undefined, { signal: timer.signal }).then(() => {
          throw new RuntimeError('CANCELLATION_UNCONFIRMED', 'Native tools have not stopped')
        })
      ])
    } finally {
      timer.abort()
    }
  }
  dispose(): Promise<void> {
    this.#disposing ??= this.#dispose()
    return this.#disposing
  }
  async #dispose() {
    this.#disposed = true
    for (const run of this.#runs.values()) {
      run.controller.abort()
    }
    await Promise.all([...this.#runs.values()].map((run) => run.done))
    await this.#settleTools(this.#tools)
    await this.#opening?.catch(() => {})
    this.#saver?.db.close()
    this.#saver = undefined
  }
}
