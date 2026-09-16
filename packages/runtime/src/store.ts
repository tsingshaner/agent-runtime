// cspell:ignore pglite regclass pgdata timestamptz
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { EventType } from '@ag-ui/core'
import { PGlite } from '@electric-sql/pglite'
import { and, asc, defineRelations, desc, eq, getTableColumns, gt, inArray, sql } from 'drizzle-orm'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'
import * as v from 'valibot'

import { parseEvent, startedEvent, type TerminalOutcome, terminalEvent } from './ag-ui'
import { RuntimeError } from './errors'
import { acquireDirectoryLock, type DirectoryLock } from './lock'
import * as schema from './schema'
import { approvals, events, runs, sessions } from './schema'
import { subscribeToRun } from './subscription'
import {
  ArchivedSchema,
  type Cursor,
  CursorSchema,
  type InsertSessionInput,
  InsertSessionInputSchema,
  JsonObjectSchema,
  PageInputSchema,
  parseInput,
  SessionFilterSchema,
  SessionIdSchema
} from './validation'

import type {
  AdapterNotice,
  AgUiEvent,
  Approval,
  ApprovalDecision,
  EventEnvelope,
  Page,
  Run,
  Session,
  SessionFilter
} from './types'

const DecisionSchema = v.picklist(['approve', 'deny'])
const ApprovalRequestSchema = v.strictObject({
  allowedDecisions: v.pipe(v.array(DecisionSchema), v.minLength(1)),
  detail: JsonObjectSchema,
  kind: v.picklist(['command', 'file-change']),
  nativeRequestId: v.union([v.string(), v.pipe(v.number(), v.safeInteger())])
})
const migrationsFolder = fileURLToPath(new URL('../drizzle', import.meta.url))
const relations = defineRelations(schema)
const activeStatuses = ['starting', 'running', 'waiting_approval', 'cancelling'] as const
const sessionSelection = { ...getTableColumns(sessions), activeRunId: runs.id }

function toSession(row: typeof sessions.$inferSelect & { activeRunId: string | null }): Session {
  return {
    ...row,
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString()
  }
}

function encodeCursor(session: Pick<Session, 'createdAt' | 'id'>): string {
  return Buffer.from(JSON.stringify({ createdAt: session.createdAt, id: session.id })).toString('base64url')
}

function decodeCursor(encoded: string | undefined): Cursor | undefined {
  if (encoded === undefined) {
    return undefined
  }
  try {
    return parseInput(CursorSchema, JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')))
  } catch {
    throw new RuntimeError('INVALID_INPUT', 'Invalid input')
  }
}

type Transaction = Parameters<Parameters<PgliteDatabase<typeof relations>['transaction']>[0]>[0]

function toRun(row: typeof runs.$inferSelect): Run {
  return {
    ...row,
    createdAt: new Date(row.createdAt).toISOString(),
    endedAt: row.endedAt === null ? null : new Date(row.endedAt).toISOString()
  }
}

async function requireRun(db: Transaction | PgliteDatabase<typeof relations>, id: string): Promise<Run> {
  const [row] = await db
    .select()
    .from(runs)
    .where(eq(runs.id, parseInput(SessionIdSchema, id)))
  if (!row) {
    throw new RuntimeError('RUN_NOT_FOUND', `Run not found: ${id}`)
  }
  return toRun(row)
}

async function persistEvent(tx: Transaction, runId: string, event: AgUiEvent): Promise<EventEnvelope> {
  const [row] = await tx
    .update(runs)
    .set({ lastSequence: sql`${runs.lastSequence} + 1` })
    .where(eq(runs.id, runId))
    .returning()
  if (!row) {
    throw new RuntimeError('RUN_NOT_FOUND', `Run not found: ${runId}`)
  }
  await tx.insert(events).values({ event, runId, sequence: row.lastSequence })
  return { event, runId, sequence: row.lastSequence, sessionId: row.sessionId }
}

async function rejectUnknownMigrations(client: PGlite): Promise<void> {
  const table = await client.query<{ name: string | null }>(
    `select to_regclass('drizzle.__drizzle_migrations')::text as name`
  )
  if (!table.rows[0]?.name) {
    return
  }

  const applied = await client.query<{ name: string | null }>('select name from drizzle.__drizzle_migrations')
  const known = new Set(readMigrationFiles({ migrationsFolder }).map((migration) => migration.name))
  const unknown = applied.rows.find(({ name }) => name === null || !known.has(name))

  if (unknown) {
    throw new RuntimeError('UNKNOWN_MIGRATION', `Database contains unknown migration: ${unknown.name ?? '(unnamed)'}`)
  }
}

export class SessionStore {
  readonly db: PgliteDatabase<typeof relations>
  private closePromise?: Promise<void>
  private readonly listeners = new Map<string, Set<() => void>>()

  private constructor(
    private readonly client: PGlite,
    private readonly lock: DirectoryLock,
    db: PgliteDatabase<typeof relations>
  ) {
    this.db = db
  }

  static async open(dataDir: string): Promise<SessionStore> {
    const lock = await acquireDirectoryLock(dataDir)
    let client: PGlite | undefined

    try {
      client = await PGlite.create(join(dataDir, 'pgdata'), { relaxedDurability: false })
      const db = drizzle({ client, relations })
      await rejectUnknownMigrations(client)
      await migrate(db, { migrationsFolder })
      return new SessionStore(client, lock, db)
    } catch (error) {
      if (client) {
        try {
          await client.close()
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], 'Failed to open store and shut down PGlite', {
            cause: error
          })
        }
      }
      try {
        await lock.release()
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'Failed to open store and release ownership', {
          cause: error
        })
      }
      throw error
    }
  }

  async insertSession(input: InsertSessionInput): Promise<Session> {
    const validated = parseInput(InsertSessionInputSchema, input)
    const [row] = await this.db.insert(sessions).values(validated).returning()
    if (!row) {
      throw new Error('Session insert returned no row')
    }
    return toSession({ ...row, activeRunId: null })
  }

  async getSession(id: string): Promise<Session> {
    const validatedId = parseInput(SessionIdSchema, id)
    const [row] = await this.db
      .select(sessionSelection)
      .from(sessions)
      .leftJoin(runs, and(eq(runs.sessionId, sessions.id), inArray(runs.status, activeStatuses)))
      .where(eq(sessions.id, validatedId))
      .limit(1)

    if (!row) {
      throw new RuntimeError('SESSION_NOT_FOUND', `Session not found: ${validatedId}`)
    }
    return toSession(row)
  }

  async listSessions(filter: SessionFilter = {}): Promise<Page<Session>> {
    const validated = parseInput(SessionFilterSchema, filter)
    const cursor = decodeCursor(validated.cursor)
    const rows = await this.db
      .select(sessionSelection)
      .from(sessions)
      .leftJoin(runs, and(eq(runs.sessionId, sessions.id), inArray(runs.status, activeStatuses)))
      .where(
        and(
          validated.projectId === undefined ? undefined : eq(sessions.projectId, validated.projectId),
          validated.runtime === undefined ? undefined : eq(sessions.runtime, validated.runtime),
          eq(sessions.archived, validated.archived ?? false),
          cursor === undefined
            ? undefined
            : sql`(${sessions.createdAt}, ${sessions.id}) < (${cursor.createdAt}::timestamptz, ${cursor.id})`
        )
      )
      .orderBy(desc(sessions.createdAt), desc(sessions.id))
      .limit(validated.limit + 1)
    const items = rows.slice(0, validated.limit).map(toSession)

    return {
      items,
      nextCursor: rows.length > validated.limit ? encodeCursor(items.at(-1) as Session) : null
    }
  }

  async setArchived(id: string, archived: boolean): Promise<void> {
    const validatedId = parseInput(SessionIdSchema, id)
    const validatedArchived = parseInput(ArchivedSchema, archived)

    await this.db.transaction(async (tx) => {
      const [row] = await tx
        .select({ activeRunId: runs.id, archived: sessions.archived, id: sessions.id })
        .from(sessions)
        .leftJoin(runs, and(eq(runs.sessionId, sessions.id), inArray(runs.status, activeStatuses)))
        .where(eq(sessions.id, validatedId))
        .limit(1)
      if (!row) {
        throw new RuntimeError('SESSION_NOT_FOUND', `Session not found: ${validatedId}`)
      }
      if (validatedArchived && row.activeRunId !== null) {
        throw new RuntimeError('SESSION_BUSY', `Session has an active run: ${validatedId}`)
      }
      if (row.archived === validatedArchived) {
        return
      }
      await tx
        .update(sessions)
        .set({ archived: validatedArchived, updatedAt: sql`now()` })
        .where(eq(sessions.id, validatedId))
    })
  }

  async beginRun(sessionId: string, runId: string): Promise<Run> {
    parseInput(SessionIdSchema, sessionId)
    parseInput(SessionIdSchema, runId)
    const run = await this.db.transaction(async (tx) => {
      const [session] = await tx.select().from(sessions).where(eq(sessions.id, sessionId))
      if (!session) {
        throw new RuntimeError('SESSION_NOT_FOUND', `Session not found: ${sessionId}`)
      }
      if (session.archived) {
        throw new RuntimeError('SESSION_ARCHIVED', `Session is archived: ${sessionId}`)
      }
      const [inserted] = await tx
        .insert(runs)
        .values({ id: runId, sessionId, status: 'starting' })
        .onConflictDoNothing({
          target: runs.sessionId,
          where: sql`${runs.status} in ('starting', 'running', 'waiting_approval', 'cancelling')`
        })
        .returning()
      if (!inserted) {
        throw new RuntimeError('SESSION_BUSY', `Session has an active run: ${sessionId}`)
      }
      await persistEvent(tx, runId, startedEvent(sessionId, runId))
      await tx.update(sessions).set({ updatedAt: sql`now()` }).where(eq(sessions.id, sessionId))
      return requireRun(tx, runId)
    })
    this.notifyRunChange(runId)
    return run
  }

  getRun(id: string): Promise<Run> {
    return requireRun(this.db, id)
  }

  async listRuns(sessionId: string, page: { limit?: number; cursor?: string } = {}): Promise<Page<Run>> {
    const validated = parseInput(PageInputSchema, page)
    const cursor = decodeCursor(validated.cursor)
    await this.getSession(sessionId)
    const rows = await this.db
      .select()
      .from(runs)
      .where(
        and(
          eq(runs.sessionId, sessionId),
          cursor === undefined
            ? undefined
            : sql`(${runs.createdAt}, ${runs.id}) < (${cursor.createdAt}::timestamptz, ${cursor.id})`
        )
      )
      .orderBy(desc(runs.createdAt), desc(runs.id))
      .limit(validated.limit + 1)
    const items = rows.slice(0, validated.limit).map(toRun)
    return { items, nextCursor: rows.length > validated.limit ? encodeCursor(items.at(-1) as Run) : null }
  }

  async setNativeTurn(runId: string, nativeTurnId: string): Promise<void> {
    parseInput(SessionIdSchema, nativeTurnId)
    await this.db.transaction(async (tx) => {
      await requireRun(tx, runId)
      await tx
        .update(runs)
        .set({
          nativeTurnId,
          status: sql`case when ${runs.status} = 'starting' then 'running' else ${runs.status} end`
        })
        .where(and(eq(runs.id, runId), inArray(runs.status, activeStatuses)))
    })
    this.notifyRunChange(runId)
  }

  async appendEvent(runId: string, event: AgUiEvent): Promise<EventEnvelope> {
    const validated = parseEvent(event)
    if ([EventType.RUN_STARTED, EventType.RUN_FINISHED, EventType.RUN_ERROR].some((type) => type === validated.type)) {
      throw new RuntimeError('INVALID_INPUT', 'Run lifecycle events are managed by the store')
    }
    const envelope = await this.db.transaction(async (tx) => {
      const run = await requireRun(tx, runId)
      if (!activeStatuses.some((status) => status === run.status)) {
        throw new RuntimeError('RUN_TERMINAL', `Run is terminal: ${runId}`)
      }
      return persistEvent(tx, runId, validated)
    })
    this.notifyRunChange(runId)
    return envelope
  }

  async finishRun(runId: string, outcome: TerminalOutcome): Promise<void> {
    const changed = await this.db.transaction(async (tx) => {
      const run = await requireRun(tx, runId)
      const event = terminalEvent(run.sessionId, runId, outcome)
      const [updated] = await tx
        .update(runs)
        .set({ endedAt: sql`now()`, error: outcome.error ?? null, status: outcome.status })
        .where(and(eq(runs.id, runId), inArray(runs.status, activeStatuses)))
        .returning()
      if (!updated) {
        return false
      }
      const expired = await tx
        .update(approvals)
        .set({ status: 'expired' })
        .where(and(eq(approvals.runId, runId), inArray(approvals.status, ['pending', 'responding'])))
        .returning()
      for (const approval of expired) {
        await persistEvent(
          tx,
          runId,
          parseEvent({
            name: 'runtime.approval.resolved',
            type: EventType.CUSTOM,
            value: { approvalId: approval.id, decision: approval.decision, status: 'expired' }
          })
        )
      }
      await persistEvent(tx, runId, event)
      return true
    })
    if (changed) {
      this.notifyRunChange(runId)
    }
  }

  async requestApproval(
    runId: string,
    request: Extract<AdapterNotice, { kind: 'approval' }>['request']
  ): Promise<Approval> {
    const validated = parseInput(ApprovalRequestSchema, request)
    const approval = await this.db.transaction(async (tx) => {
      const run = await requireRun(tx, runId)
      if (!activeStatuses.some((status) => status === run.status)) {
        throw new RuntimeError('RUN_TERMINAL', 'Run is terminal')
      }
      const [existing] = await tx
        .select()
        .from(approvals)
        .where(and(eq(approvals.runId, runId), eq(approvals.nativeRequestId, validated.nativeRequestId)))
      if (existing) {
        return existing
      }
      const [inserted] = await tx
        .insert(approvals)
        .values({ ...validated, id: randomUUID(), runId, status: 'pending' })
        .returning()
      if (!inserted) {
        throw new Error('Approval insert returned no row')
      }
      await tx
        .update(runs)
        .set({ status: 'waiting_approval' })
        .where(and(eq(runs.id, runId), inArray(runs.status, ['starting', 'running'])))
      const { nativeRequestId: _nativeRequestId, ...publicApproval } = inserted
      await persistEvent(
        tx,
        runId,
        parseEvent({ name: 'runtime.approval.requested', type: EventType.CUSTOM, value: publicApproval })
      )
      return inserted
    })
    this.notifyRunChange(runId)
    return approval
  }

  async claimApproval(runId: string, approvalId: string, decision: ApprovalDecision): Promise<Approval> {
    parseInput(SessionIdSchema, runId)
    parseInput(SessionIdSchema, approvalId)
    parseInput(DecisionSchema, decision)
    return await this.db.transaction(async (tx) => {
      const condition = and(eq(approvals.runId, runId), eq(approvals.id, approvalId))
      const [approval] = await tx.select().from(approvals).where(condition)
      if (!approval) {
        throw new RuntimeError('APPROVAL_NOT_FOUND', 'Approval not found for run')
      }
      if (approval.status !== 'pending') {
        throw new RuntimeError('APPROVAL_NOT_PENDING', 'Approval is not pending')
      }
      if (!approval.allowedDecisions.includes(decision)) {
        throw new RuntimeError('INVALID_INPUT', 'Decision is not allowed')
      }
      const [claimed] = await tx
        .update(approvals)
        .set({ decision, status: 'responding' })
        .where(and(condition, eq(approvals.status, 'pending')))
        .returning()
      if (!claimed) {
        throw new RuntimeError('APPROVAL_NOT_PENDING', 'Approval is not pending')
      }
      return claimed
    })
  }

  async resolveApproval(runId: string, nativeRequestId: string | number): Promise<void> {
    await this.db.transaction(async (tx) => {
      await requireRun(tx, runId)
      const [approval] = await tx
        .update(approvals)
        .set({ status: sql`case when ${approvals.status} = 'responding' then 'resolved' else 'expired' end` })
        .where(
          and(
            eq(approvals.runId, runId),
            eq(approvals.nativeRequestId, nativeRequestId),
            inArray(approvals.status, ['pending', 'responding'])
          )
        )
        .returning()
      if (!approval) {
        return
      }
      await persistEvent(
        tx,
        runId,
        parseEvent({
          name: 'runtime.approval.resolved',
          type: EventType.CUSTOM,
          value: { approvalId: approval.id, decision: approval.decision, status: approval.status }
        })
      )
      const [remaining] = await tx
        .select({ id: approvals.id })
        .from(approvals)
        .where(and(eq(approvals.runId, runId), inArray(approvals.status, ['pending', 'responding'])))
        .limit(1)
      if (!remaining) {
        await tx
          .update(runs)
          .set({ status: 'running' })
          .where(and(eq(runs.id, runId), eq(runs.status, 'waiting_approval')))
      }
    })
    this.notifyRunChange(runId)
  }

  async listPendingApprovals(runId: string): Promise<Approval[]> {
    await this.getRun(runId)
    return this.db
      .select()
      .from(approvals)
      .where(and(eq(approvals.runId, runId), inArray(approvals.status, ['pending', 'responding'])))
      .orderBy(asc(approvals.id))
  }

  async markCancelling(runId: string): Promise<Run> {
    return await this.db.transaction(async (tx) => {
      await requireRun(tx, runId)
      await tx
        .update(runs)
        .set({ status: 'cancelling' })
        .where(and(eq(runs.id, runId), inArray(runs.status, activeStatuses)))
      return requireRun(tx, runId)
    })
  }

  readEventPage(runId: string, afterSequence: number, limit = 128): Promise<EventEnvelope[]> {
    return this.db.transaction(async (tx) => {
      const run = await requireRun(tx, runId)
      if (run.eventsCleared) {
        throw new RuntimeError('EVENTS_CLEARED', `Events cleared: ${runId}`)
      }
      if (!Number.isSafeInteger(afterSequence) || afterSequence < 0 || !Number.isSafeInteger(limit) || limit < 1) {
        throw new RuntimeError('INVALID_INPUT', 'Invalid event page')
      }
      const rows = await tx
        .select()
        .from(events)
        .where(and(eq(events.runId, runId), gt(events.sequence, afterSequence)))
        .orderBy(asc(events.sequence))
        .limit(limit)
      return rows.map((row) => ({
        event: parseEvent(row.event),
        runId,
        sequence: row.sequence,
        sessionId: run.sessionId
      }))
    })
  }

  async clearRunEvents(runId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const run = await requireRun(tx, runId)
      if (activeStatuses.some((status) => status === run.status)) {
        throw new RuntimeError('RUN_ACTIVE', `Run is active: ${runId}`)
      }
      await tx.update(runs).set({ eventsCleared: true }).where(eq(runs.id, runId))
      await tx.delete(events).where(eq(events.runId, runId))
    })
    this.notifyRunChange(runId)
  }

  onRunChange(runId: string, listener: () => void): () => void {
    let listeners = this.listeners.get(runId)
    if (!listeners) {
      listeners = new Set()
      this.listeners.set(runId, listeners)
    }
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) {
        this.listeners.delete(runId)
      }
    }
  }

  private notifyRunChange(runId: string): void {
    for (const listener of this.listeners.get(runId) ?? []) {
      listener()
    }
  }

  subscribe(runId: string, options?: { afterSequence?: number; signal?: AbortSignal }): AsyncIterable<EventEnvelope> {
    return subscribeToRun(this, runId, options)
  }

  close(): Promise<void> {
    this.closePromise ??= this.closeOwnedResources()
    return this.closePromise
  }

  private async closeOwnedResources(): Promise<void> {
    await this.client.close()
    await this.lock.release()
  }
}
