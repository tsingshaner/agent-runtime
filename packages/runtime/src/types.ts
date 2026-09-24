import type { EventSchemas, EventType } from '@ag-ui/core'

import type { ProjectResources, ResourceSnapshot } from './resources'

/**
 * An event validated against the AG-UI event schemas.
 */
export type AgUiEvent = ReturnType<typeof EventSchemas.parse>

/**
 * A JSON value. Runtime validation rejects cycles and non-finite numbers.
 */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
/**
 * A JSON object used for persisted runtime options and approval details.
 */
export type JsonObject = { [key: string]: Json }
/**
 * A decision to approve or deny a native operation.
 */
export type ApprovalDecision = 'approve' | 'deny'
/**
 * Persisted run lifecycle; interrupted marks unsafe native termination or unfinished work recovered after restart.
 */
export type RunStatus =
  | 'starting'
  | 'running'
  | 'waiting_approval'
  | 'waiting_input'
  | 'cancelling'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'interrupted'
/**
 * Approval lifecycle; responding means a decision was claimed but is not yet confirmed.
 */
export type ApprovalStatus = 'decided' | 'pending' | 'responding' | 'resolved' | 'expired'
/**
 * Serializable error code and message stored with a run.
 */
export type RuntimeFault = { code: string; message: string }

/** Stable project identity independent of its working directories. */
export interface Project {
  id: string
  name: string
  workingDirectories: string[]
  createdAt: string
  updatedAt: string
}

/** Project creation; an explicit ID can be used by existing integrations. */
export interface CreateProjectInput {
  id?: string
  name: string
  workingDirectories?: string[]
}

/** Editable project metadata; session identities remain unchanged. */
export interface UpdateProjectInput {
  name?: string
  workingDirectories?: string[]
}

/** A session created through this SDK, with SDK and native identities stored separately. */
export interface Session {
  id: string
  runtime: string
  nativeSessionId: string
  projectId: string
  cwd: string
  title: string
  /** Null only for legacy sessions which did not persist a model. */
  model: string | null
  options: JsonObject
  createdAt: string
  updatedAt: string
  archived: boolean
  /**
   * The current active run, or null when the session is idle.
   */
  activeRunId: string | null
}

/**
 * A persisted execution attempt belonging to one managed session.
 */
/** Optional request identity is scoped to the session; text is compared exactly. */
export interface RunInput {
  text: string
  requestId?: string
}

export interface MemoryWrite {
  runId: string
  projectId: string
  sessionId: string
  user: string
  assistant: string
  status: 'pending' | 'accepted' | 'failed' | 'unknown'
  error: RuntimeFault | null
}

/** Resource seam implemented by ProjectMemory; no runtime dependency in the resource package. */
export interface MemoryProvider {
  recall(projectId: string, query: string): Promise<{ context: string }>
  write(
    input: Pick<MemoryWrite, 'projectId' | 'sessionId' | 'runId' | 'user' | 'assistant'>
  ): Promise<{ status: 'accepted' | 'failed' | 'unknown'; error?: RuntimeFault }>
}

export interface Run {
  memoryError: RuntimeFault | null
  requestId: string | null
  id: string
  sessionId: string
  nativeTurnId: string | null
  status: RunStatus
  error: RuntimeFault | null
  createdAt: string
  endedAt: string | null
  /**
   * Highest committed event sequence; retained even after events are cleared.
   */
  lastSequence: number
  /**
   * Whether event history was explicitly removed and replay is unavailable.
   */
  eventsCleared: boolean
}

/**
 * A durable AG-UI event with a run-local sequence used for replay.
 */
export interface EventEnvelope {
  sessionId: string
  runId: string
  /**
   * Monotonically increasing sequence within this run, starting at 1.
   */
  sequence: number
  event: AgUiEvent
}

/**
 * A persisted native approval request and its response state.
 */
export interface Approval {
  id: string
  runId: string
  nativeRequestId: string | number
  kind: 'command' | 'file-change' | 'tool'
  batchId: string | null
  batchIndex: number | null
  detail: JsonObject
  allowedDecisions: ApprovalDecision[]
  status: ApprovalStatus
  decision: ApprovalDecision | null
}

/** A question may accept free text or one of the suggested options. */
export interface InputQuestion {
  id: string
  header: string
  question: string
  isOther?: boolean
  isSecret?: boolean
  options?: { label: string; description: string }[] | null
}
export type InputAnswers = Record<string, string[]>
export interface InputRequest {
  id: string
  runId: string
  nativeRequestId: string | number
  questions: InputQuestion[]
  status: 'pending' | 'responding' | 'resolved' | 'expired'
  answers: InputAnswers | null
}

/** Typed AG-UI extensions for durable input interactions. */
export type InputEvent =
  | { type: EventType.CUSTOM; name: 'runtime.input.requested'; value: Omit<InputRequest, 'nativeRequestId'> }
  | {
      type: EventType.CUSTOM
      name: 'runtime.input.resolved'
      value: { inputId: string; status: 'resolved' | 'expired' }
    }

/**
 * Adapter notifications consumed in order by the manager for durable persistence.
 */
export type ApprovalBatchDecision = { nativeRequestId: string | number; decision: ApprovalDecision }
export type AdapterNotice =
  | {
      kind: 'approval-batch'
      request: {
        nativeRequestId: string | number
        requests: Omit<Approval, 'id' | 'runId' | 'status' | 'decision' | 'batchId' | 'batchIndex'>[]
      }
    }
  | { kind: 'approval-batch-resolved'; nativeRequestId: string | number; responseAttempted?: boolean }
  | { kind: 'input'; request: Pick<InputRequest, 'nativeRequestId' | 'questions'> }
  | { kind: 'input-resolved'; nativeRequestId: string | number; responseAttempted?: boolean }
  | { kind: 'started'; nativeTurnId: string }
  | { kind: 'event'; event: AgUiEvent }
  | {
      kind: 'approval'
      request: Omit<Approval, 'id' | 'runId' | 'status' | 'decision' | 'batchId' | 'batchIndex'>
    }
  | {
      kind: 'approval-resolved'
      nativeRequestId: string | number
      /**
       * Snapshot when native resolution arrives. False means no response was attempted and forces expired/null,
       * even after a durable claim. Omission falls back to persisted claim state for adapter compatibility.
       */
      responseAttempted?: boolean
    }

/**
 * The final result of native execution after its notices have been delivered.
 */
export interface AdapterOutcome {
  /** Only the final assistant reply, excluding commentary and tool output. */
  finalReply?: string
  status: 'succeeded' | 'failed' | 'cancelled' | 'interrupted'
  error?: RuntimeFault
}

/**
 * Native identity and effective options required to resume a managed session.
 */
export interface NativeSession {
  projectId?: string
  model?: string

  nativeSessionId: string
  cwd: string
  options: JsonObject
}

/**
 * The common runtime contract implemented by native adapters.
 *
 * @remarks
 * Adapters own native processes; the manager owns persistence and run lifecycle events.
 */
export interface RuntimeAdapter {
  /**
   * Unique runtime key used to select this adapter.
   */
  readonly kind: string
  configureProject?(projectId: string, snapshot: ResourceSnapshot): Promise<void>
  /**
   * Create a native session and return its effective working directory and options.
   */
  createSession(input: {
    cwd: string
    model?: string
    projectId?: string
    options?: JsonObject
  }): Promise<NativeSession>
  /**
   * Load a previously managed native session; repeated calls must be safe.
   */
  resumeSession(session: NativeSession): Promise<void>
  /**
   * Execute one run and await each emit callback before delivering the next notice.
   *
   * @returns The terminal outcome after all notices have been delivered.
   */
  execute(
    session: NativeSession,
    input: { sessionId: string; runId: string; text: string; context?: string },
    emit: (notice: AdapterNotice) => Promise<void>
  ): Promise<AdapterOutcome>
  /**
   * Request cancellation of the identified run without stopping other sessions.
   */
  cancel(runId: string): Promise<void>
  /**
   * Send a decision for the native request associated with this run.
   */
  /** Answer a native input request; adapters must emit input-resolved after confirmation. */
  respondInput?(runId: string, nativeRequestId: string | number, answers: InputAnswers): Promise<void>
  /** Submit one fully decided native batch in its original order. */
  respondApprovalBatch?(
    runId: string,
    nativeRequestId: string | number,
    decisions: ApprovalBatchDecision[]
  ): Promise<void>
  respondApproval(runId: string, nativeRequestId: string | number, decision: ApprovalDecision): Promise<void>
  /**
   * Release all resources owned by this adapter; repeated calls must be safe.
   */
  dispose(): Promise<void>
}

/**
 * A page of results with an opaque cursor, or null when there are no more results.
 */
export interface Page<T> {
  items: T[]
  nextCursor: string | null
}

/**
 * Session filters and pagination; archived defaults to false and limit defaults to 50.
 */
export interface SessionFilter {
  projectId?: string
  runtime?: string
  archived?: boolean
  limit?: number
  cursor?: string
}

/**
 * Persistent data directory and runtime adapters owned by the manager.
 */
export interface ManagerOptions<A extends RuntimeAdapter = RuntimeAdapter> {
  resources?: ProjectResources
  memory?: MemoryProvider
  memoryTimeoutMs?: number
  /**
   * Persistent directory exclusively owned until the manager is disposed.
   */
  dataDir: string
  /**
   * Adapters with unique kind values; disposed together with the manager.
   */
  runtimes: A[]
}

/**
 * Input for creating an SDK-managed session through a registered runtime.
 */
export type CreateSessionInput<A extends RuntimeAdapter = RuntimeAdapter> = A extends RuntimeAdapter
  ? {
      runtime: A['kind']
      model: string
      projectId: string
      cwd: string
      title?: string
      options?: Parameters<A['createSession']>[0]['options']
    }
  : never
