import { realpath, stat } from 'node:fs/promises'

import {
  type AdapterNotice,
  type AdapterOutcome,
  type ApprovalDecision,
  type JsonObject,
  type NativeSession,
  type RuntimeAdapter,
  RuntimeError
} from '@qingshaner/runtime'
import * as v from 'valibot'

import { version } from '../package.json'
import { JsonRpcClient } from './client'
import { CodexEventMapper } from './events'
import { type Frame, parseProtocol, ThreadResponseSchema, TurnNotificationSchema, TurnResponseSchema } from './protocol'

import type { InitializeParams } from './schemas/InitializeParams'
import type { ThreadResumeParams } from './schemas/v2/ThreadResumeParams'
import type { ThreadStartParams } from './schemas/v2/ThreadStartParams'
import type { TurnStartParams } from './schemas/v2/TurnStartParams'

const nonempty = v.pipe(v.string(), v.trim(), v.minLength(1))
const timeout = v.optional(v.pipe(v.number(), v.safeInteger(), v.minValue(1), v.maxValue(2_147_483_647)))
const OptionsSchema = v.strictObject({
  codexHome: v.optional(nonempty),
  executable: v.optional(v.strictObject({ args: v.optional(v.array(v.string())), command: nonempty })),
  model: nonempty,
  requestTimeoutMs: timeout,
  shutdownTimeoutMs: timeout
})
const SessionOptionsSchema = v.strictObject({
  approvalPolicy: v.optional(v.picklist(['on-request', 'never']), 'on-request'),
  model: v.optional(nonempty),
  sandbox: v.optional(v.picklist(['read-only', 'workspace-write']), 'workspace-write')
})
export type CodexRuntimeOptions = v.InferInput<typeof OptionsSchema>
type Notification = Extract<Frame, { kind: 'notification' }>
type QueueEntry = { frame?: Notification; notice?: AdapterNotice; bytes: number }
interface ActiveRun {
  runId: string
  threadId: string
  turnId?: string
  client?: JsonRpcClient
  mapper: CodexEventMapper
  emit: (notice: AdapterNotice) => Promise<void>
  queue: QueueEntry[]
  bytes: number
  count: number
  pumping: boolean
  responseDone: boolean
  cancelRequested: boolean
  interrupt?: Promise<void>
  fault?: RuntimeError
  outcome?: AdapterOutcome
  stopping?: Promise<void>
  nativeEnded: boolean
  onNativeEnd?: () => void
  finished: boolean
  resolve: (outcome: AdapterOutcome) => void
}

function validate<T extends v.GenericSchema>(schema: T, value: unknown): v.InferOutput<T> {
  const result = v.safeParse(schema, value)
  if (!result.success) {
    throw new RuntimeError('INVALID_INPUT', 'Invalid Codex runtime input')
  }
  return result.output
}
function failure(error: unknown): RuntimeError {
  return error instanceof RuntimeError ? error : new RuntimeError('ADAPTER_ERROR', 'Codex runtime operation failed')
}
function failed(error: RuntimeError): AdapterOutcome {
  return { error: { code: error.code, message: error.message }, status: 'failed' }
}

export class CodexRuntime implements RuntimeAdapter {
  readonly kind = 'codex'
  private readonly options: v.InferOutput<typeof OptionsSchema>
  private client?: JsonRpcClient
  private starting?: Promise<JsonRpcClient>
  private disposed = false
  private closing?: Promise<void>
  private readonly loaded = new Map<string, Promise<void>>()
  private readonly runs = new Map<string, ActiveRun>()
  private readonly threads = new Map<string, ActiveRun>()

  constructor(options: CodexRuntimeOptions) {
    this.options = validate(OptionsSchema, options)
  }

  async createSession(input: { cwd: string; options?: JsonObject }): Promise<NativeSession> {
    this.checkOpen()
    const options = this.sessionOptions(input.options ?? {})
    const cwd = await this.directory(input.cwd)
    const client = await this.start()
    const params = { cwd, ...options, approvalsReviewer: 'user', ephemeral: false } satisfies ThreadStartParams
    const result = parseProtocol(ThreadResponseSchema, await client.request('thread/start', params))
    this.loaded.set(result.thread.id, Promise.resolve())
    return { cwd, nativeSessionId: result.thread.id, options }
  }

  async resumeSession(session: NativeSession): Promise<void> {
    this.checkOpen()
    const nativeSessionId = validate(nonempty, session.nativeSessionId)
    const options = this.sessionOptions(session.options)
    const cwd = await this.directory(session.cwd)
    const client = await this.start()
    const existing = this.loaded.get(nativeSessionId)
    if (existing) {
      return existing
    }
    const resume = (async () => {
      const params = {
        cwd,
        threadId: nativeSessionId,
        ...options,
        approvalsReviewer: 'user'
      } satisfies ThreadResumeParams
      const result = parseProtocol(ThreadResponseSchema, await client.request('thread/resume', params))
      if (result.thread.id !== nativeSessionId) {
        throw new RuntimeError('PROTOCOL_ERROR', 'Resumed thread identity does not match')
      }
    })()
    this.loaded.set(nativeSessionId, resume)
    try {
      await resume
    } catch (error) {
      if (this.loaded.get(nativeSessionId) === resume) {
        this.loaded.delete(nativeSessionId)
      }
      throw error
    }
  }

  async execute(
    session: NativeSession,
    input: { sessionId: string; runId: string; text: string },
    emit: (notice: AdapterNotice) => Promise<void>
  ): Promise<AdapterOutcome> {
    this.checkOpen()
    validate(v.strictObject({ runId: nonempty, sessionId: nonempty, text: nonempty }), input)
    validate(nonempty, session.nativeSessionId)
    if (this.runs.has(input.runId) || this.threads.has(session.nativeSessionId)) {
      throw new RuntimeError('RUN_CONFLICT', 'Session already has an active run')
    }
    return await new Promise<AdapterOutcome>((resolve) => {
      const run: ActiveRun = {
        bytes: 0,
        cancelRequested: false,
        count: 0,
        emit,
        finished: false,
        mapper: new CodexEventMapper(input.sessionId, input.runId),
        nativeEnded: false,
        pumping: false,
        queue: [],
        resolve,
        responseDone: false,
        runId: input.runId,
        threadId: session.nativeSessionId
      }
      this.runs.set(input.runId, run)
      this.threads.set(session.nativeSessionId, run)
      void this.begin(run, session, input.text)
    })
  }

  async cancel(runId: string): Promise<void> {
    this.checkOpen()
    const run = this.runs.get(runId)
    if (!run || run.finished || run.outcome) {
      return
    }
    run.cancelRequested = true
    if (run.turnId) {
      await this.interrupt(run)
    }
  }

  // biome-ignore lint/suspicious/useAwait: Adapter methods consistently reject asynchronously.
  async respondApproval(_runId: string, _nativeRequestId: string | number, _decision: ApprovalDecision): Promise<void> {
    this.checkOpen()
    throw new RuntimeError('APPROVAL_NOT_FOUND', 'No pending approval request')
  }

  dispose(): Promise<void> {
    if (!this.closing) {
      this.disposed = true
      this.closing = (async () => {
        await this.client?.close()
        for (const run of this.runs.values()) {
          this.fail(run, new RuntimeError('DISPOSED', 'Codex runtime disposed'))
        }
        this.loaded.clear()
      })()
    }
    return this.closing
  }

  private checkOpen(): void {
    if (this.disposed) {
      throw new RuntimeError('DISPOSED', 'Codex runtime disposed')
    }
  }
  private sessionOptions(value: unknown) {
    const options = validate(SessionOptionsSchema, value)
    return { ...options, model: options.model ?? this.options.model }
  }
  private async directory(value: string): Promise<string> {
    validate(nonempty, value)
    try {
      const cwd = await realpath(value)
      if (!(await stat(cwd)).isDirectory()) {
        throw new Error('Not a directory')
      }
      return cwd
    } catch {
      throw new RuntimeError('INVALID_INPUT', 'Working directory must exist and be a directory')
    }
  }

  private start(): Promise<JsonRpcClient> {
    this.checkOpen()
    if (!this.starting) {
      const executable = this.options.executable ?? { command: 'codex' }
      const client = new JsonRpcClient({
        args: [...(executable.args ?? []), 'app-server'],
        command: executable.command,
        // biome-ignore lint/style/useNamingConvention: Native environment variable.
        env: this.options.codexHome ? { ...process.env, CODEX_HOME: this.options.codexHome } : process.env,
        requestTimeoutMs: this.options.requestTimeoutMs,
        shutdownTimeoutMs: this.options.shutdownTimeoutMs
      })
      this.client = client
      client.onFrame((frame) => this.route(client, frame))
      client.onExit((error) => {
        if (this.client === client) {
          this.client = undefined
          this.starting = undefined
          this.loaded.clear()
        }
        for (const run of this.runs.values()) {
          if (run.client !== client || (run.nativeEnded && run.responseDone)) {
            continue
          }
          run.nativeEnded = true
          run.onNativeEnd?.()
          this.fail(run, error)
        }
      })
      this.starting = (async () => {
        try {
          const params = {
            capabilities: null,
            clientInfo: { name: 'agent-runtime', title: null, version }
          } satisfies InitializeParams
          await client.request('initialize', params)
          await client.notify('initialized', {})
          this.checkOpen()
          return client
        } catch (error) {
          await client.close()
          throw error
        }
      })()
    }
    return this.starting
  }

  private async begin(run: ActiveRun, session: NativeSession, text: string): Promise<void> {
    try {
      await this.resumeSession(session)
      this.checkOpen()
      if (run.finished) {
        return
      }
      const client = await this.start()
      run.client = client
      const params = {
        // biome-ignore lint/style/useNamingConvention: Native protocol field.
        input: [{ text, text_elements: [], type: 'text' }],
        threadId: session.nativeSessionId
      } satisfies TurnStartParams
      const { turn } = parseProtocol(TurnResponseSchema, await client.request('turn/start', params))
      if (run.finished) {
        return
      }
      if (run.turnId && run.turnId !== turn.id) {
        this.fail(run, new RuntimeError('PROTOCOL_ERROR', 'Started turn identity does not match notifications'))
        await client.close()
        return
      }
      this.bind(run, turn.id)
      run.responseDone = true
      if (turn.status !== 'inProgress') {
        this.route(client, { kind: 'notification', method: 'turn/completed', params: { threadId: run.threadId, turn } })
      }
      this.pump(run)
    } catch (error) {
      run.responseDone = true
      this.fail(run, failure(error))
    }
  }

  private route(client: JsonRpcClient, frame: Frame): void {
    if (frame.kind === 'server-request') {
      this.rejectRequest(client, frame)
      return
    }
    if (
      frame.kind !== 'notification' ||
      !frame.params ||
      typeof frame.params !== 'object' ||
      Array.isArray(frame.params)
    ) {
      return
    }
    const threadId = frame.params.threadId
    if (typeof threadId !== 'string') {
      return
    }
    const run = this.threads.get(threadId)
    if (!run || run.client !== client || run.finished) {
      return
    }
    const method = frame.method
    if (
      ![
        'turn/started',
        'turn/completed',
        'item/started',
        'item/completed',
        'item/agentMessage/delta',
        'item/commandExecution/outputDelta',
        'item/fileChange/outputDelta',
        'error'
      ].includes(method)
    ) {
      return
    }
    const turnId =
      method === 'turn/started' || method === 'turn/completed'
        ? parseProtocol(TurnNotificationSchema, frame.params).turn.id
        : frame.params.turnId
    if (typeof turnId !== 'string' || (run.turnId && run.turnId !== turnId)) {
      return
    }
    this.bind(run, turnId)
    if (method === 'turn/completed') {
      run.nativeEnded = true
      run.onNativeEnd?.()
    }
    if (run.fault) {
      return
    }
    this.enqueue(run, { bytes: Buffer.byteLength(JSON.stringify(frame)), frame })
  }

  private rejectRequest(client: JsonRpcClient, frame: Extract<Frame, { kind: 'server-request' }>): void {
    const supported =
      frame.method === 'item/commandExecution/requestApproval' || frame.method === 'item/fileChange/requestApproval'
    const reply = supported
      ? client.reply(frame.id, { decision: 'decline' })
      : client.replyError(frame.id, -32601, 'Unsupported server request')
    void reply.catch(() => client.close())
  }

  private bind(run: ActiveRun, turnId: string): void {
    if (!run.turnId) {
      run.turnId = turnId
      this.enqueue(run, { bytes: turnId.length, notice: { kind: 'started', nativeTurnId: turnId } })
    }
    if (run.cancelRequested) {
      void this.interrupt(run).catch(() => {})
    }
  }

  private interrupt(run: ActiveRun): Promise<void> {
    if (!run.interrupt && run.client && run.turnId) {
      run.interrupt = run.client
        .request('turn/interrupt', { threadId: run.threadId, turnId: run.turnId })
        .then(() => {})
    }
    return run.interrupt ?? Promise.resolve()
  }

  private enqueue(run: ActiveRun, entry: QueueEntry): void {
    if (run.finished || run.fault || run.outcome) {
      return
    }
    if (run.count + 1 > 1024 || run.bytes + entry.bytes > 8 * 1024 * 1024) {
      this.fail(run, new RuntimeError('STREAM_OVERFLOW', 'Run notification queue exceeded its limit'))
      return
    }
    run.queue.push(entry)
    run.count++
    run.bytes += entry.bytes
    this.pump(run)
  }

  private fail(run: ActiveRun, error: RuntimeError): void {
    if (run.finished || run.fault) {
      return
    }
    run.fault = error
    // Failed runs explicitly discard pending frames; already awaited output stays ordered.
    run.queue.length = 0
    run.outcome = failed(error)
    run.responseDone = true
    run.stopping = (async () => {
      if (!run.client || run.nativeEnded) {
        return
      }
      if (!run.turnId) {
        await run.client.close()
        return
      }
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await this.interrupt(run)
        if (!run.nativeEnded) {
          await new Promise<void>((resolve, reject) => {
            run.onNativeEnd = resolve
            timer = setTimeout(
              () => reject(new RuntimeError('RPC_TIMEOUT', 'Native interruption was not confirmed')),
              this.options.requestTimeoutMs ?? 15_000
            )
          })
        }
      } catch {
        await run.client.close()
      } finally {
        clearTimeout(timer)
        run.onNativeEnd = undefined
      }
    })()
    this.pump(run)
  }

  private pump(run: ActiveRun): void {
    if (run.pumping || run.finished) {
      return
    }
    run.pumping = true
    void this.drain(run)
      .catch(async (error) => {
        if (run.fault) {
          await run.stopping
          this.complete(run, failed(run.fault))
        } else {
          this.fail(run, failure(error))
        }
      })
      .finally(() => {
        run.pumping = false
        if (!run.finished && (run.queue.length > 0 || (run.outcome && run.responseDone))) {
          this.pump(run)
        }
      })
  }

  private async drain(run: ActiveRun): Promise<void> {
    let entry = run.queue.shift()
    while (entry) {
      if (entry.notice) {
        await run.emit(entry.notice)
      }
      if (entry.frame) {
        await this.project(run, entry.frame)
      }
      run.count--
      run.bytes -= entry.bytes
      entry = run.queue.shift()
    }
    if (run.outcome && run.responseDone) {
      await run.stopping
      for (const notice of run.mapper.finish(run.outcome)) {
        await run.emit(notice)
      }
      this.complete(run, run.outcome)
    }
  }

  private async project(run: ActiveRun, frame: Notification): Promise<void> {
    if (frame.method !== 'turn/completed') {
      for (const notice of run.mapper.accept(frame.method, frame.params)) {
        await run.emit(notice)
      }
      return
    }
    const { turn } = parseProtocol(TurnNotificationSchema, frame.params)
    if (turn.status === 'inProgress') {
      throw new RuntimeError('PROTOCOL_ERROR', 'Completed turn is still in progress')
    }
    run.outcome ??=
      turn.status === 'completed'
        ? { status: 'succeeded' }
        : turn.status === 'interrupted'
          ? { status: 'cancelled' }
          : failed(new RuntimeError('RUN_FAILED', 'Codex turn failed'))
  }

  private complete(run: ActiveRun, outcome: AdapterOutcome): void {
    run.finished = true
    this.runs.delete(run.runId)
    this.threads.delete(run.threadId)
    run.resolve(outcome)
  }
}
