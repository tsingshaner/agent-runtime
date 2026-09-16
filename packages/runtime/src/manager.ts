import { randomUUID } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'

import * as v from 'valibot'

import { RuntimeError } from './errors'
import { SessionStore } from './store'
import { JsonObjectSchema, parseInput } from './validation'

import type {
  AdapterNotice,
  AdapterOutcome,
  Approval,
  ApprovalDecision,
  CreateSessionInput,
  EventEnvelope,
  ManagerOptions,
  NativeSession,
  Page,
  Run,
  RuntimeAdapter,
  Session,
  SessionFilter
} from './types'

const NonBlankString = v.pipe(
  v.string(),
  v.check((value) => value.trim().length > 0)
)
const TitleSchema = v.pipe(NonBlankString, v.maxLength(256))
const CreateSessionSchema = v.strictObject({
  cwd: NonBlankString,
  options: v.optional(JsonObjectSchema),
  projectId: NonBlankString,
  runtime: NonBlankString,
  title: v.optional(TitleSchema)
})
const RunInputSchema = v.strictObject({ text: NonBlankString })
const ManagerOptionsSchema = v.strictObject({
  dataDir: NonBlankString,
  runtimes: v.array(
    v.custom<RuntimeAdapter>((value) => {
      if (value === null || typeof value !== 'object') {
        return false
      }
      const adapter = value as RuntimeAdapter
      return (
        typeof adapter.kind === 'string' &&
        adapter.kind.trim().length > 0 &&
        ['createSession', 'resumeSession', 'execute', 'cancel', 'respondApproval', 'dispose'].every(
          (method) => typeof Reflect.get(adapter, method) === 'function'
        )
      )
    })
  )
})

export class RuntimeManager {
  private readonly active = new Map<string, Promise<void>>()
  private readonly ready = new Map<string, Promise<void>>()
  private readonly cancellations = new Map<string, Promise<void>>()
  private closing = false
  private closePromise?: Promise<void>
  private storageError?: unknown

  private constructor(
    private readonly store: SessionStore,
    private readonly adapters: Map<string, RuntimeAdapter>
  ) {}

  static async open(options: ManagerOptions): Promise<RuntimeManager> {
    const validated = parseInput(ManagerOptionsSchema, options)
    const adapters = new Map(validated.runtimes.map((adapter) => [adapter.kind, adapter]))
    if (adapters.size !== validated.runtimes.length) {
      throw new RuntimeError('INVALID_INPUT', 'Duplicate runtime kind')
    }
    return new RuntimeManager(await SessionStore.open(validated.dataDir), adapters)
  }

  async createSession(input: CreateSessionInput): Promise<Session> {
    this.assertOpen()
    const validated = parseInput(CreateSessionSchema, input)
    const title = parseInput(TitleSchema, validated.title ?? validated.projectId)
    const adapter = this.getAdapter(validated.runtime)
    let cwd: string
    try {
      cwd = await realpath(validated.cwd)
      if (!(await stat(cwd)).isDirectory()) {
        throw new Error('Not a directory')
      }
    } catch (cause) {
      throw new RuntimeError('INVALID_INPUT', 'cwd must be an existing directory', { cause })
    }
    const native = await adapter.createSession({ cwd, options: validated.options })
    return this.store.insertSession({
      cwd: native.cwd,
      id: randomUUID(),
      nativeSessionId: native.nativeSessionId,
      options: native.options,
      projectId: validated.projectId,
      runtime: validated.runtime,
      title
    })
  }

  async getSession(sessionId: string): Promise<Session> {
    this.assertOpen()
    return await this.store.getSession(sessionId)
  }

  async listSessions(filter?: SessionFilter): Promise<Page<Session>> {
    this.assertOpen()
    return await this.store.listSessions(filter)
  }

  async resumeSession(sessionId: string): Promise<Session> {
    this.assertOpen()
    const session = await this.store.getSession(sessionId)
    await this.getAdapter(session.runtime).resumeSession(this.nativeSession(session))
    return session
  }

  async archiveSession(sessionId: string): Promise<void> {
    this.assertOpen()
    await this.store.setArchived(sessionId, true)
  }

  async unarchiveSession(sessionId: string): Promise<void> {
    this.assertOpen()
    await this.store.setArchived(sessionId, false)
  }

  async run(sessionId: string, input: { text: string }): Promise<{ runId: string; sessionId: string }> {
    this.assertOpen()
    const validated = parseInput(RunInputSchema, input)
    const session = await this.store.getSession(sessionId)
    const adapter = this.getAdapter(session.runtime)
    const runId = randomUUID()
    await this.store.beginRun(sessionId, runId)
    let signalReady!: () => void
    this.ready.set(
      runId,
      new Promise<void>((resolve) => {
        signalReady = resolve
      })
    )
    const completion = this.drive(adapter, session, runId, validated, signalReady)
      .catch((error: unknown) => {
        // Fail closed if even the terminal transaction cannot be persisted.
        this.storageError = error
        this.closing = true
      })
      .finally(() => {
        signalReady()
        this.active.delete(runId)
        this.ready.delete(runId)
        this.cancellations.delete(runId)
      })
    this.active.set(runId, completion)
    return { runId, sessionId }
  }

  async getRun(runId: string): Promise<Run> {
    this.assertOpen()
    return await this.store.getRun(runId)
  }

  async listRuns(sessionId: string, page?: { limit?: number; cursor?: string }): Promise<Page<Run>> {
    this.assertOpen()
    return await this.store.listRuns(sessionId, page)
  }

  subscribe(runId: string, options?: { afterSequence?: number; signal?: AbortSignal }): AsyncIterable<EventEnvelope> {
    this.assertOpen()
    return this.store.subscribe(runId, options)
  }

  async clearRunEvents(runId: string): Promise<void> {
    this.assertOpen()
    await this.store.clearRunEvents(runId)
  }

  async listPendingApprovals(runId: string): Promise<Approval[]> {
    this.assertOpen()
    return await this.store.listPendingApprovals(runId)
  }

  async respondApproval(runId: string, approvalId: string, decision: ApprovalDecision): Promise<void> {
    this.assertOpen()
    const run = await this.store.getRun(runId)
    const session = await this.store.getSession(run.sessionId)
    const adapter = this.getAdapter(session.runtime)
    const approval = await this.store.claimApproval(runId, approvalId, decision)
    try {
      await adapter.respondApproval(runId, approval.nativeRequestId, decision)
    } catch (cause) {
      throw new RuntimeError('APPROVAL_RESPONSE_UNCERTAIN', 'Approval response was not confirmed', { cause })
    }
  }

  async cancel(runId: string): Promise<void> {
    this.assertOpen()
    let cancellation = this.cancellations.get(runId)
    if (!cancellation) {
      cancellation = this.cancelRun(runId).finally(() => {
        if (!this.active.has(runId)) {
          this.cancellations.delete(runId)
        }
      })
      this.cancellations.set(runId, cancellation)
    }
    await cancellation
  }

  private async cancelRun(runId: string): Promise<void> {
    const run = await this.store.markCancelling(runId)
    if (run.status !== 'cancelling') {
      return
    }
    const session = await this.store.getSession(run.sessionId)
    const adapter = this.getAdapter(session.runtime)
    await this.ready.get(runId)
    if ((await this.store.getRun(runId)).status !== 'cancelling') {
      return
    }
    try {
      await adapter.cancel(runId)
    } catch (cause) {
      if (cause instanceof RuntimeError && cause.code === 'RPC_TIMEOUT') {
        throw new RuntimeError('CANCEL_TIMEOUT', 'Cancellation request timed out', { cause })
      }
      throw cause
    }
  }

  dispose(): Promise<void> {
    this.closing = true
    this.closePromise ??= this.closeResources()
    return this.closePromise
  }

  private async closeResources(): Promise<void> {
    await Promise.all([...this.adapters.values()].map((adapter) => adapter.dispose()))
    await Promise.all(this.active.values())
    await this.store.close()
    if (this.storageError !== undefined) {
      throw this.storageError
    }
  }

  private assertOpen(): void {
    if (this.closing) {
      throw new RuntimeError('DISPOSED', 'Manager is closing or disposed', { cause: this.storageError })
    }
  }

  private getAdapter(kind: string): RuntimeAdapter {
    const adapter = this.adapters.get(kind)
    if (!adapter) {
      throw new RuntimeError('RUNTIME_UNAVAILABLE', `Runtime is unavailable: ${kind}`)
    }
    return adapter
  }

  private nativeSession({ nativeSessionId, cwd, options }: Session): NativeSession {
    return { cwd, nativeSessionId, options }
  }

  private async drive(
    adapter: RuntimeAdapter,
    session: Session,
    runId: string,
    input: { text: string },
    ready: () => void
  ): Promise<void> {
    let outcome: AdapterOutcome
    try {
      const native = this.nativeSession(session)
      await adapter.resumeSession(native)
      const execution = adapter.execute(native, { ...input, runId, sessionId: session.id }, (notice) =>
        this.receive(runId, notice)
      )
      ready()
      outcome = await execution
    } catch (error) {
      outcome = {
        error: {
          code: error instanceof RuntimeError ? error.code : 'RUN_FAILED',
          message: error instanceof Error ? error.message : 'Run failed'
        },
        status: 'failed'
      }
    }
    await this.store.finishRun(runId, outcome)
  }

  private async receive(runId: string, notice: AdapterNotice): Promise<void> {
    switch (notice.kind) {
      case 'started':
        await this.store.setNativeTurn(runId, notice.nativeTurnId)
        return
      case 'event':
        await this.store.appendEvent(runId, notice.event)
        return
      case 'approval':
        await this.store.requestApproval(runId, notice.request)
        return
      case 'approval-resolved':
        await this.store.resolveApproval(runId, notice.nativeRequestId)
        return
    }
  }
}
