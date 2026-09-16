import { realpath, stat } from 'node:fs/promises'

import {
  type AdapterNotice,
  type AdapterOutcome,
  type ApprovalDecision,
  type Json,
  type JsonObject,
  type NativeSession,
  type RuntimeAdapter,
  RuntimeError
} from '@qingshaner/runtime'
import * as v from 'valibot'

import { version } from '../package.json'
import { JsonRpcClient } from './client'
import { CodexEventMapper } from './events'
import {
  ApprovalResponseSchema,
  CommandApprovalSchema,
  DeclineElicitationSchema,
  EmptyAnswersSchema,
  FileApprovalSchema,
  type Frame,
  NoPermissionsSchema,
  parseProtocol,
  RequestResolvedSchema,
  ThreadResponseSchema,
  TurnNotificationSchema,
  TurnResponseSchema
} from './protocol'

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
type QueueEntry = { frame?: Notification; notice?: AdapterNotice; bytes: number; responseAttempted?: boolean }
interface PendingApproval {
  allowedDecisions: ApprovalDecision[]
  responding: boolean
  resolved: boolean
  confirmation?: ReturnType<typeof deferred>
}
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
  cancellation?: ReturnType<typeof deferred>
  approvals: Map<string | number, PendingApproval>
  fault?: RuntimeError
  outcome?: AdapterOutcome
  stopping?: Promise<void>
  nativeEnded: boolean
  onNativeEnd?: () => void
  finished: boolean
  resolve: (outcome: AdapterOutcome) => void
}

function deferred() {
  let resolve!: () => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, reject, resolve }
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
    this.checkClient(client)
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
      this.checkClient(client)
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
        approvals: new Map(),
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
    run.cancellation ??= deferred()
    this.sendCancellation(run)
    await run.cancellation.promise
  }

  async respondApproval(runId: string, nativeRequestId: string | number, decision: ApprovalDecision): Promise<void> {
    this.checkOpen()
    const run = this.runs.get(runId)
    const approval = run?.approvals.get(nativeRequestId)
    if (!(run?.client && approval)) {
      throw new RuntimeError('APPROVAL_NOT_FOUND', 'No approval request for run')
    }
    if (approval.responding || approval.resolved) {
      throw new RuntimeError('APPROVAL_NOT_PENDING', 'Approval is not pending')
    }
    if (!approval.allowedDecisions.includes(decision)) {
      throw new RuntimeError('INVALID_INPUT', 'Decision is not allowed')
    }
    approval.responding = true
    const confirmation = deferred()
    approval.confirmation = confirmation
    const uncertain = () => new RuntimeError('APPROVAL_RESPONSE_UNCERTAIN', 'Approval response was not confirmed')
    const timer = setTimeout(() => confirmation.reject(uncertain()), this.options.requestTimeoutMs ?? 15_000)
    // Observe confirmation before writing: a very fast native resolution may arrive first.
    const result = confirmation.promise.finally(() => clearTimeout(timer))
    void run.client
      .reply(
        nativeRequestId,
        parseProtocol(ApprovalResponseSchema, { decision: decision === 'approve' ? 'accept' : 'decline' })
      )
      .catch(() => confirmation.reject(uncertain()))
    await result
  }

  dispose(): Promise<void> {
    if (!this.closing) {
      this.disposed = true
      this.closing = (async () => {
        await this.client?.close()
        for (const run of this.runs.values()) {
          this.fail(run, new RuntimeError('PROCESS_EXITED', 'Codex runtime disposed'))
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
  private checkClient(client: JsonRpcClient): void {
    this.checkOpen()
    if (this.client !== client) {
      throw new RuntimeError('PROCESS_EXITED', 'App-server generation ended')
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
      client.onFrame((frame) => {
        if (this.client === client) {
          this.route(client, frame)
        }
      })
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
          this.checkClient(client)
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
      const client = this.client
      if (!client) {
        throw new RuntimeError('PROCESS_EXITED', 'App-server generation ended before turn start')
      }
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
      this.handleRequest(client, frame)
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
    if (method === 'serverRequest/resolved') {
      this.resolveRequest(run, frame)
      return
    }
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

  private handleRequest(client: JsonRpcClient, frame: Extract<Frame, { kind: 'server-request' }>): void {
    if (
      frame.method === 'item/commandExecution/requestApproval' ||
      frame.method === 'item/fileChange/requestApproval'
    ) {
      this.requestApproval(client, frame)
      return
    }
    let result: Json | undefined
    switch (frame.method) {
      case 'item/tool/requestUserInput':
        result = parseProtocol(EmptyAnswersSchema, { answers: {} })
        break
      case 'mcpServer/elicitation/request':
        result = parseProtocol(DeclineElicitationSchema, { _meta: null, action: 'decline', content: null })
        break
      case 'item/permissions/requestApproval':
        result = parseProtocol(NoPermissionsSchema, { permissions: {}, scope: 'turn' })
        break
    }
    if (result !== undefined) {
      void client.reply(frame.id, result).catch(() => client.close())
      return
    }
    const params = frame.params
    const threadId = params && typeof params === 'object' && !Array.isArray(params) ? params.threadId : undefined
    const run = typeof threadId === 'string' ? this.threads.get(threadId) : undefined
    void client.replyError(frame.id, -32601, 'Unsupported server request').then(
      () => {
        if (run && run.client === client && !run.finished) {
          this.fail(run, new RuntimeError('UNSUPPORTED_REQUEST', 'Unsupported native request'))
        } else {
          void client.close()
        }
      },
      () => client.close()
    )
  }

  private resolveRequest(run: ActiveRun, frame: Notification): void {
    const { requestId } = parseProtocol(RequestResolvedSchema, frame.params)
    const approval = run.approvals.get(requestId)
    if (!approval || approval.resolved) {
      return
    }
    approval.resolved = true
    this.enqueue(run, {
      bytes: Buffer.byteLength(JSON.stringify(frame)),
      frame,
      responseAttempted: approval.responding
    })
  }

  private requestApproval(client: JsonRpcClient, frame: Extract<Frame, { kind: 'server-request' }>): void {
    const command = frame.method === 'item/commandExecution/requestApproval'
    const params = parseProtocol(command ? CommandApprovalSchema : FileApprovalSchema, frame.params)
    const run = this.threads.get(params.threadId)
    if (
      !run ||
      run.client !== client ||
      run.finished ||
      run.nativeEnded ||
      (run.turnId && run.turnId !== params.turnId)
    ) {
      void client
        .reply(frame.id, parseProtocol(ApprovalResponseSchema, { decision: 'decline' }))
        .catch(() => client.close())
      return
    }
    if (run.approvals.has(frame.id)) {
      this.fail(run, new RuntimeError('PROTOCOL_ERROR', 'Duplicate native approval request'))
      return
    }
    this.bind(run, params.turnId)
    const available = params.availableDecisions
    const allowedDecisions: ApprovalDecision[] = []
    if (!available || available.includes('accept')) {
      allowedDecisions.push('approve')
    }
    if (!available || available.includes('decline')) {
      allowedDecisions.push('deny')
    }
    if (allowedDecisions.length === 0) {
      void client.replyError(frame.id, -32601, 'No supported approval decision').then(
        () => this.fail(run, new RuntimeError('UNSUPPORTED_APPROVAL', 'No supported approval decision')),
        () => client.close()
      )
      return
    }
    run.approvals.set(frame.id, { allowedDecisions, resolved: false, responding: false })
    const detail = JSON.parse(JSON.stringify(params)) as JsonObject
    this.enqueue(run, {
      bytes: Buffer.byteLength(JSON.stringify(frame)),
      notice: {
        kind: 'approval',
        request: { allowedDecisions, detail, kind: command ? 'command' : 'file-change', nativeRequestId: frame.id }
      }
    })
  }

  private sendCancellation(run: ActiveRun): void {
    if (run.cancelRequested && run.turnId && run.cancellation) {
      void this.interrupt(run).then(run.cancellation.resolve, run.cancellation.reject)
    }
  }

  private bind(run: ActiveRun, turnId: string): void {
    if (!run.turnId) {
      run.turnId = turnId
      this.enqueue(run, { bytes: turnId.length, notice: { kind: 'started', nativeTurnId: turnId } })
    }
    this.sendCancellation(run)
  }

  private interrupt(run: ActiveRun): Promise<void> {
    if (!run.interrupt && run.client && run.turnId) {
      run.interrupt = run.client
        .request('turn/interrupt', { threadId: run.threadId, turnId: run.turnId })
        .then(() => {})
        .catch((cause: unknown) => {
          if (cause instanceof RuntimeError && cause.code === 'RPC_TIMEOUT') {
            throw new RuntimeError('CANCEL_TIMEOUT', 'Cancellation request timed out', { cause })
          }
          throw cause
        })
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
        await this.project(run, entry.frame, entry.responseAttempted)
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

  private async project(run: ActiveRun, frame: Notification, responseAttempted?: boolean): Promise<void> {
    if (frame.method === 'serverRequest/resolved') {
      const { requestId } = parseProtocol(RequestResolvedSchema, frame.params)
      await run.emit({ kind: 'approval-resolved', nativeRequestId: requestId, responseAttempted })
      run.approvals.get(requestId)?.confirmation?.resolve()
      return
    }
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
    run.cancellation?.resolve()
    for (const approval of run.approvals.values()) {
      approval.confirmation?.reject(
        new RuntimeError('APPROVAL_RESPONSE_UNCERTAIN', 'Run ended before approval confirmation')
      )
    }
    run.approvals.clear()
    this.runs.delete(run.runId)
    this.threads.delete(run.threadId)
    run.resolve(outcome)
  }
}
