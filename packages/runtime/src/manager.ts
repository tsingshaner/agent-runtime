import { randomUUID } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'

import * as v from 'valibot'

import { parseEvent } from './ag-ui'
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

/**
 * Owns durable sessions, background runs, approvals, and registered runtime adapters.
 */
export class RuntimeManager {
  private readonly active = new Map<string, { done: Promise<void>; adapter: RuntimeAdapter }>()
  private readonly controls = new Set<Promise<unknown>>()
  private readonly storageOperations = new Set<Promise<unknown>>()
  private stop!: () => void
  private readonly stopped = new Promise<void>((resolve) => {
    this.stop = resolve
  })
  private stopping = false
  private storeClosed = false
  private readonly ready = new Map<string, Promise<void>>()
  private readonly cancellations = new Map<string, Promise<void>>()
  private closing = false
  private closePromise?: Promise<void>
  private fatal: RuntimeError | null = null

  private constructor(
    private readonly store: SessionStore,
    private readonly adapters: Map<string, RuntimeAdapter>
  ) {}

  /**
   * Open the persistent store and mark unfinished runs from a previous host as interrupted.
   *
   * @remarks
   * Acquires exclusive directory ownership. Opening does not start native runtime processes.
   *
   * @throws {@link RuntimeError} when options are invalid or the data directory is already owned.
   */
  static async open(options: ManagerOptions): Promise<RuntimeManager> {
    const validated = parseInput(ManagerOptionsSchema, options)
    const adapters = new Map(validated.runtimes.map((adapter) => [adapter.kind, adapter]))
    if (adapters.size !== validated.runtimes.length) {
      throw new RuntimeError('INVALID_INPUT', 'Duplicate runtime kind')
    }
    const store = await SessionStore.open(validated.dataDir)
    try {
      await store.recoverInterrupted()
      return new RuntimeManager(store, adapters)
    } catch (cause) {
      const error = new RuntimeError('STORAGE_ERROR', 'Failed to recover unfinished runs', { cause })
      try {
        await store.close()
      } catch (cleanup) {
        throw new AggregateError([error, cleanup], 'Recovery and store cleanup failed', { cause: error })
      }
      throw error
    }
  }

  /**
   * Create and persist a session through the selected runtime.
   *
   * @param input - Runtime key, project identity, existing working directory, and optional native settings.
   * @returns The SDK-managed session with its native identity and effective options.
   */
  async createSession(input: CreateSessionInput): Promise<Session> {
    return await this.control(async () => {
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
      this.assertRunning()
      const native = await adapter.createSession({ cwd, options: validated.options })
      this.assertRunning()
      return this.storage(() =>
        this.store.insertSession({
          cwd: native.cwd,
          id: randomUUID(),
          nativeSessionId: native.nativeSessionId,
          options: native.options,
          projectId: validated.projectId,
          runtime: validated.runtime,
          title
        })
      )
    })
  }

  /**
   * Read an SDK-managed session by its SDK ID.
   *
   * @throws {@link RuntimeError} if the session is not in this store.
   */
  async getSession(sessionId: string): Promise<Session> {
    this.assertOpen()
    return await this.storage(() => this.store.getSession(sessionId))
  }

  /**
   * List managed sessions from newest to oldest; excludes archived sessions by default.
   */
  async listSessions(filter?: SessionFilter): Promise<Page<Session>> {
    this.assertOpen()
    return await this.storage(() => this.store.listSessions(filter))
  }

  /**
   * Load a persisted session in its native runtime without starting a run.
   */
  async resumeSession(sessionId: string): Promise<Session> {
    return await this.control(async () => {
      const session = await this.storage(() => this.store.getSession(sessionId))
      this.assertRunning()
      await this.getAdapter(session.runtime).resumeSession(this.nativeSession(session))
      return session
    })
  }

  /**
   * Archive an idle session without deleting its runs or native state.
   *
   * @throws {@link RuntimeError} if the session has an active run.
   */
  async archiveSession(sessionId: string): Promise<void> {
    this.assertOpen()
    await this.storage(() => this.store.setArchived(sessionId, true))
  }

  /**
   * Restore an archived session to the default session listing.
   */
  async unarchiveSession(sessionId: string): Promise<void> {
    this.assertOpen()
    await this.storage(() => this.store.setArchived(sessionId, false))
  }

  /**
   * Persist a new run and start execution in the background.
   *
   * @remarks
   * Returns before execution completes. Use subscribe to receive durable events.
   * Execution continues independently of subscribers while the manager remains alive.
   *
   * @returns SDK session and run IDs for later queries, subscriptions, and cancellation.
   * @throws {@link RuntimeError} if the session is archived or already has an active run.
   */
  async run(sessionId: string, input: { text: string }): Promise<{ runId: string; sessionId: string }> {
    return await this.control(async () => {
      const validated = parseInput(RunInputSchema, input)
      const session = await this.storage(() => this.store.getSession(sessionId))
      this.assertRunning()
      const adapter = this.getAdapter(session.runtime)
      const runId = randomUUID()
      await this.storage(() => this.store.beginRun(sessionId, runId))
      this.assertRunning()
      let signalReady!: () => void
      this.ready.set(
        runId,
        new Promise<void>((resolve) => {
          signalReady = resolve
        })
      )
      const completion = this.drive(adapter, session, runId, validated, signalReady)
        .catch((error: unknown) => {
          this.failStorage(error)
        })
        .finally(() => {
          signalReady()
          this.active.delete(runId)
          this.ready.delete(runId)
          this.cancellations.delete(runId)
        })
      this.active.set(runId, { adapter, done: completion })
      return { runId, sessionId }
    })
  }

  /**
   * Read a persisted run by its SDK ID.
   */
  async getRun(runId: string): Promise<Run> {
    this.assertOpen()
    return await this.storage(() => this.store.getRun(runId))
  }

  /**
   * List a session's runs from newest to oldest using an opaque pagination cursor.
   */
  async listRuns(sessionId: string, page?: { limit?: number; cursor?: string }): Promise<Page<Run>> {
    this.assertOpen()
    return await this.storage(() => this.store.listRuns(sessionId, page))
  }

  /**
   * Replay persisted events, then follow new events until the run ends.
   *
   * @param runId - SDK run ID.
   * @param options - Exclusive sequence cursor and optional signal that stops only this subscription.
   * @returns An independent async iterable; save each sequence to resume after reconnecting.
   * @throws {@link RuntimeError} during iteration if the cursor is invalid or events were cleared.
   */
  subscribe(runId: string, options?: { afterSequence?: number; signal?: AbortSignal }): AsyncIterable<EventEnvelope> {
    this.assertOpen()
    return this.store.subscribe(runId, options)
  }

  /**
   * Delete event history for a terminal run while retaining run metadata.
   *
   * @throws {@link RuntimeError} if the run is still active.
   */
  async clearRunEvents(runId: string): Promise<void> {
    this.assertOpen()
    await this.storage(() => this.store.clearRunEvents(runId))
  }

  /**
   * List pending and responding approvals, including responses awaiting native confirmation.
   */
  async listPendingApprovals(runId: string): Promise<Approval[]> {
    this.assertOpen()
    return await this.storage(() => this.store.listPendingApprovals(runId))
  }

  /**
   * Durably claim an approval before sending its decision to the native runtime.
   *
   * @remarks
   * A claimed response is never automatically resent. A transport failure may leave its outcome uncertain.
   *
   * @throws {@link RuntimeError} if the approval cannot be claimed or its response is unconfirmed.
   */
  async respondApproval(runId: string, approvalId: string, decision: ApprovalDecision): Promise<void> {
    return await this.control(async () => {
      const run = await this.storage(() => this.store.getRun(runId))
      const session = await this.storage(() => this.store.getSession(run.sessionId))
      const adapter = this.getAdapter(session.runtime)
      const approval = await this.storage(() => this.store.claimApproval(runId, approvalId, decision))
      this.assertRunning()
      try {
        await adapter.respondApproval(runId, approval.nativeRequestId, decision)
      } catch (cause) {
        throw new RuntimeError('APPROVAL_RESPONSE_UNCERTAIN', 'Approval response was not confirmed', { cause })
      }
    })
  }

  /**
   * Request cancellation of one run; concurrent requests share the same operation.
   *
   * @remarks
   * Completion acknowledges the request; observe the run for its final status.
   */
  async cancel(runId: string): Promise<void> {
    return await this.control(async () => {
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
    })
  }

  private async cancelRun(runId: string): Promise<void> {
    const run = await this.storage(() => this.store.markCancelling(runId))
    if (run.status !== 'cancelling') {
      return
    }
    const session = await this.storage(() => this.store.getSession(run.sessionId))
    const adapter = this.getAdapter(session.runtime)
    await this.ready.get(runId)
    if ((await this.storage(() => this.store.getRun(runId))).status !== 'cancelling') {
      return
    }
    this.assertRunning()
    try {
      await adapter.cancel(runId)
    } catch (cause) {
      if (cause instanceof RuntimeError && cause.code === 'RPC_TIMEOUT') {
        throw new RuntimeError('CANCEL_TIMEOUT', 'Cancellation request timed out', { cause })
      }
      throw cause
    }
  }

  /**
   * Stop accepting work, cancel active runs, and close adapters and the persistent store.
   *
   * @remarks
   * Repeated calls share the same promise. Directory ownership is retained if database shutdown fails.
   *
   * @throws An AggregateError if resource cleanup fails.
   */
  dispose(): Promise<void> {
    this.closing = true
    this.closePromise ??= this.closeResources()
    return this.closePromise
  }

  private async closeResources(): Promise<void> {
    const errors: unknown[] = []
    const attempt = async (operation: () => Promise<unknown>) => {
      try {
        await operation()
      } catch (error) {
        errors.push(error)
      }
    }
    await attempt(() => this.bounded(Promise.allSettled(this.controls), 'Accepted operations'))
    await attempt(() =>
      this.bounded(
        (async () => {
          const cancellations = [...this.active].map(
            ([runId, { adapter }]) =>
              this.cancellations.get(runId) ?? (this.fatal ? adapter.cancel(runId) : this.cancelRun(runId))
          )
          const results = await Promise.allSettled(cancellations)
          for (const result of results) {
            if (result.status === 'rejected') {
              errors.push(result.reason)
            }
          }
          await Promise.all([...this.active.values()].map(({ done }) => done))
        })(),
        'Run cancellation'
      )
    )
    // No continuation of a timed out control operation may start more native work.
    this.stopping = true
    await Promise.all(
      [...this.adapters.values()].map((adapter) =>
        attempt(() =>
          this.bounded(
            Promise.resolve().then(() => adapter.dispose()),
            'Adapter disposal'
          )
        )
      )
    )
    this.stop()
    await attempt(() => this.bounded(Promise.all([...this.active.values()].map(({ done }) => done)), 'Run persistence'))
    // Seal the boundary before draining: late adapter callbacks can no longer enqueue I/O.
    this.storeClosed = true
    await attempt(async () => {
      try {
        await this.bounded(Promise.allSettled(this.storageOperations), 'Database operations')
      } catch (error) {
        this.store.fail(
          new RuntimeError('STORAGE_ERROR', 'Database operations did not drain; ownership retained', { cause: error })
        )
        throw error
      }
      await this.bounded(this.store.close(), 'Database close')
    })
    if (this.fatal) {
      errors.unshift(this.fatal)
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, 'Failed to close runtime resources', { cause: this.fatal ?? errors[0] })
    }
  }

  private async bounded<T>(operation: Promise<T>, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new RuntimeError('DISPOSE_TIMEOUT', `${label} timed out`)), 5000)
        })
      ])
    } finally {
      clearTimeout(timer)
    }
  }

  private control<T>(operation: () => Promise<T>): Promise<T> {
    this.assertOpen()
    const pending = operation().finally(() => this.controls.delete(pending))
    this.controls.add(pending)
    return pending
  }

  private storage<T>(operation: () => Promise<T>): Promise<T> {
    if (this.fatal) {
      return Promise.reject(this.fatal)
    }
    if (this.storeClosed) {
      return Promise.reject(new RuntimeError('DISPOSED', 'Manager disposed'))
    }
    const pending = Promise.resolve()
      .then(() => {
        if (this.fatal) {
          throw this.fatal
        }
        return operation()
      })
      .catch((error: unknown) => {
        if (error instanceof RuntimeError && error.code !== 'STORAGE_ERROR') {
          throw error
        }
        throw this.failStorage(error)
      })
      .finally(() => this.storageOperations.delete(pending))
    this.storageOperations.add(pending)
    return pending
  }

  private failStorage(cause: unknown): RuntimeError {
    if (!this.fatal) {
      this.fatal =
        cause instanceof RuntimeError && cause.code === 'STORAGE_ERROR'
          ? cause
          : new RuntimeError('STORAGE_ERROR', 'Runtime persistence failed', { cause })
      this.store.fail(this.fatal)
      for (const [runId, { adapter }] of this.active) {
        void Promise.resolve()
          .then(() => adapter.cancel(runId))
          .catch(() => {})
      }
    }
    return this.fatal
  }

  private assertRunning(): void {
    if (this.fatal) {
      throw this.fatal
    }
    if (this.stopping) {
      throw new RuntimeError('DISPOSED', 'Manager is closing or disposed')
    }
  }

  private assertOpen(): void {
    if (this.fatal) {
      throw this.fatal
    }
    if (this.closing) {
      throw new RuntimeError('DISPOSED', 'Manager is closing or disposed')
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
      this.assertRunning()
      const native = this.nativeSession(session)
      await Promise.race([adapter.resumeSession(native), this.stopped])
      this.assertRunning()
      const execution = adapter.execute(native, { ...input, runId, sessionId: session.id }, (notice) =>
        this.receive(runId, notice)
      )
      ready()
      outcome = await Promise.race([
        execution,
        this.stopped.then(() => ({
          error: { code: 'PROCESS_EXITED', message: 'Runtime shut down before run completion' },
          status: 'failed' as const
        }))
      ])
    } catch (error) {
      outcome = {
        error: {
          code: this.stopping ? 'PROCESS_EXITED' : error instanceof RuntimeError ? error.code : 'RUN_FAILED',
          message: error instanceof Error ? error.message : 'Run failed'
        },
        status: 'failed'
      }
    }
    if (!this.fatal) {
      await this.storage(() => this.store.finishRun(runId, outcome))
    }
  }

  private async receive(runId: string, notice: AdapterNotice): Promise<void> {
    switch (notice.kind) {
      case 'started':
        await this.storage(() => this.store.setNativeTurn(runId, notice.nativeTurnId))
        return
      case 'event':
        parseEvent(notice.event)
        await this.storage(() => this.store.appendEvent(runId, notice.event))
        return
      case 'approval':
        await this.storage(() => this.store.requestApproval(runId, notice.request))
        return
      case 'approval-resolved':
        await this.storage(() => this.store.resolveApproval(runId, notice.nativeRequestId, notice.responseAttempted))
        return
    }
  }
}
