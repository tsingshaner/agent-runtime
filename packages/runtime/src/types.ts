import type { EventSchemas } from '@ag-ui/core'

export type AgUiEvent = ReturnType<typeof EventSchemas.parse>

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
export type JsonObject = { [key: string]: Json }
export type ApprovalDecision = 'approve' | 'deny'
export type RunStatus =
  | 'starting'
  | 'running'
  | 'waiting_approval'
  | 'cancelling'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'interrupted'
export type ApprovalStatus = 'pending' | 'responding' | 'resolved' | 'expired'
export type RuntimeFault = { code: string; message: string }

export interface Session {
  id: string
  runtime: string
  nativeSessionId: string
  projectId: string
  cwd: string
  title: string
  options: JsonObject
  createdAt: string
  updatedAt: string
  archived: boolean
  activeRunId: string | null
}

export interface Run {
  id: string
  sessionId: string
  nativeTurnId: string | null
  status: RunStatus
  error: RuntimeFault | null
  createdAt: string
  endedAt: string | null
  lastSequence: number
  eventsCleared: boolean
}

export interface EventEnvelope {
  sessionId: string
  runId: string
  sequence: number
  event: AgUiEvent
}

export interface Approval {
  id: string
  runId: string
  nativeRequestId: string | number
  kind: 'command' | 'file-change'
  detail: JsonObject
  allowedDecisions: ApprovalDecision[]
  status: ApprovalStatus
  decision: ApprovalDecision | null
}

export type AdapterNotice =
  | { kind: 'started'; nativeTurnId: string }
  | { kind: 'event'; event: AgUiEvent }
  | {
      kind: 'approval'
      request: Omit<Approval, 'id' | 'runId' | 'status' | 'decision'>
    }
  | { kind: 'approval-resolved'; nativeRequestId: string | number }

export interface AdapterOutcome {
  status: 'succeeded' | 'failed' | 'cancelled'
  error?: RuntimeFault
}

export interface NativeSession {
  nativeSessionId: string
  cwd: string
  options: JsonObject
}

export interface RuntimeAdapter {
  readonly kind: string
  createSession(input: { cwd: string; options?: JsonObject }): Promise<NativeSession>
  resumeSession(session: NativeSession): Promise<void>
  execute(
    session: NativeSession,
    input: { sessionId: string; runId: string; text: string },
    emit: (notice: AdapterNotice) => Promise<void>
  ): Promise<AdapterOutcome>
  cancel(runId: string): Promise<void>
  respondApproval(runId: string, nativeRequestId: string | number, decision: ApprovalDecision): Promise<void>
  dispose(): Promise<void>
}

export interface Page<T> {
  items: T[]
  nextCursor: string | null
}

export interface SessionFilter {
  projectId?: string
  runtime?: string
  archived?: boolean
  limit?: number
  cursor?: string
}

export interface ManagerOptions {
  dataDir: string
  runtimes: RuntimeAdapter[]
}

export interface CreateSessionInput {
  runtime: string
  projectId: string
  cwd: string
  title?: string
  options?: JsonObject
}
