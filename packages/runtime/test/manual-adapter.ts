import { realpath } from 'node:fs/promises'

import { RuntimeError } from '../src/errors'

import type {
  AdapterNotice,
  AdapterOutcome,
  ApprovalDecision,
  JsonObject,
  NativeSession,
  RuntimeAdapter
} from '../src/types'

export class ManualAdapter implements RuntimeAdapter {
  readonly kind = 'manual'
  readonly created: NativeSession[] = []
  readonly resumed: NativeSession[] = []
  readonly cancelled: string[] = []
  readonly executions = new Map<string, { sessionId: string; runId: string; text: string }>()
  private readonly active = new Map<
    string,
    { emit: (notice: AdapterNotice) => Promise<void>; outcome: PromiseWithResolvers<AdapterOutcome> }
  >()
  private readonly starts = new Map<string, PromiseWithResolvers<void>>()
  readonly decisions: { runId: string; nativeRequestId: string | number; decision: ApprovalDecision }[] = []
  cancelError?: Error
  finishOnCancel = true
  approvalError?: Error
  confirmApprovals = true
  resumeGate?: Promise<void>
  private disposed = false

  /** Reset observations and controls after all executions have completed. */
  reset(): void {
    if (this.active.size > 0 || this.disposed) {
      throw new Error('Cannot reset an active or disposed adapter')
    }
    this.created.length = 0
    this.resumed.length = 0
    this.cancelled.length = 0
    this.decisions.length = 0
    this.executions.clear()
    this.starts.clear()
    this.cancelError = undefined
    this.approvalError = undefined
    this.resumeGate = undefined
    this.finishOnCancel = true
    this.confirmApprovals = true
  }

  async createSession(input: {
    cwd: string
    model?: string
    projectId?: string
    options?: JsonObject
  }): Promise<NativeSession> {
    const session = {
      cwd: await realpath(input.cwd),
      model: input.model,
      nativeSessionId: `native-${this.created.length + 1}`,
      options: input.options ?? { model: 'test-model' },
      projectId: input.projectId
    }
    this.created.push(session)
    return session
  }

  resumeSession(session: NativeSession): Promise<void> {
    this.resumed.push(session)
    return this.resumeGate ?? Promise.resolve()
  }

  async execute(
    session: NativeSession,
    input: { sessionId: string; runId: string; text: string },
    emit: (notice: AdapterNotice) => Promise<void>
  ): Promise<AdapterOutcome> {
    if (this.disposed) {
      throw new RuntimeError('DISPOSED', 'Adapter disposed')
    }
    if (!this.resumed.some(({ nativeSessionId }) => nativeSessionId === session.nativeSessionId)) {
      throw new Error('Session must be resumed before execution')
    }
    const outcome = Promise.withResolvers<AdapterOutcome>()
    this.active.set(input.runId, { emit, outcome })
    this.executions.set(input.runId, input)
    this.starts.get(input.runId)?.resolve()
    try {
      return await outcome.promise
    } finally {
      this.active.delete(input.runId)
    }
  }

  waitStarted(runId: string): Promise<void> {
    if (this.executions.has(runId)) {
      return Promise.resolve()
    }
    let start = this.starts.get(runId)
    if (!start) {
      start = Promise.withResolvers<void>()
      this.starts.set(runId, start)
    }
    return start.promise
  }

  async push(runId: string, notice: AdapterNotice): Promise<void> {
    const execution = this.active.get(runId)
    if (!execution) {
      throw new Error(`Execution not started: ${runId}`)
    }
    try {
      await execution.emit(notice)
    } catch (error) {
      execution.outcome.reject(error)
      throw error
    }
  }

  finish(runId: string, outcome: AdapterOutcome): void {
    const execution = this.active.get(runId)
    if (!execution) {
      throw new Error(`Execution not started: ${runId}`)
    }
    execution.outcome.resolve(outcome)
  }

  cancel(runId: string): Promise<void> {
    this.cancelled.push(runId)
    if (this.cancelError) {
      return Promise.reject(this.cancelError)
    }
    if (this.finishOnCancel) {
      this.finish(runId, { status: 'cancelled' })
    }
    return Promise.resolve()
  }

  async respondApproval(runId: string, nativeRequestId: string | number, decision: ApprovalDecision): Promise<void> {
    this.decisions.push({ decision, nativeRequestId, runId })
    if (this.approvalError) {
      throw this.approvalError
    }
    if (this.confirmApprovals) {
      await this.push(runId, { kind: 'approval-resolved', nativeRequestId })
    }
  }

  dispose(): Promise<void> {
    this.disposed = true
    for (const { outcome } of this.active.values()) {
      outcome.resolve({ status: 'cancelled' })
    }
    return Promise.resolve()
  }
}
