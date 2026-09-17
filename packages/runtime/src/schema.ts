import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex
} from 'drizzle-orm/pg-core'

import type {
  ApprovalDecision,
  ApprovalStatus,
  InputAnswers,
  InputQuestion,
  InputRequest,
  JsonObject,
  RunStatus,
  RuntimeFault
} from './types'

export const projects = pgTable('projects', {
  createdAt: timestamp('created_at', { mode: 'string', withTimezone: true }).notNull().defaultNow(),
  id: text().primaryKey(),
  name: text().notNull(),
  updatedAt: timestamp('updated_at', { mode: 'string', withTimezone: true }).notNull().defaultNow(),
  workingDirectories: jsonb('working_directories').$type<string[]>().notNull().default([])
})

export const sessions = pgTable(
  'sessions',
  {
    archived: boolean().notNull().default(false),
    createdAt: timestamp('created_at', { mode: 'string', withTimezone: true }).notNull().defaultNow(),
    cwd: text().notNull(),
    id: text().primaryKey(),
    model: text(),
    nativeSessionId: text('native_session_id').notNull(),
    options: jsonb().$type<JsonObject>().notNull().default({}),
    projectId: text('project_id').notNull(),
    runtime: text().notNull(),
    title: text().notNull(),
    updatedAt: timestamp('updated_at', { mode: 'string', withTimezone: true }).notNull().defaultNow()
  },
  (table) => [unique().on(table.runtime, table.nativeSessionId)]
)

export const runs = pgTable(
  'runs',
  {
    createdAt: timestamp('created_at', { mode: 'string', withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp('ended_at', { mode: 'string', withTimezone: true }),
    error: jsonb().$type<RuntimeFault>(),
    eventsCleared: boolean('events_cleared').notNull().default(false),
    id: text().primaryKey(),
    lastSequence: integer('last_sequence').notNull().default(0),
    nativeTurnId: text('native_turn_id'),
    requestId: text('request_id'),
    requestText: text('request_text'),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id),
    status: text().$type<RunStatus>().notNull()
  },
  (table) => [
    check(
      'runs_status_check',
      sql`${table.status} in ('starting', 'running', 'waiting_approval', 'waiting_input', 'cancelling', 'succeeded', 'failed', 'cancelled', 'interrupted')`
    ),
    unique().on(table.sessionId, table.requestId),
    check('runs_last_sequence_check', sql`${table.lastSequence} >= 0`),
    uniqueIndex('one_active_run')
      .on(table.sessionId)
      .where(sql`${table.status} in ('starting', 'running', 'waiting_approval', 'waiting_input', 'cancelling')`),
    index('session_runs').on(table.sessionId, table.createdAt.desc(), table.id.desc())
  ]
)

export const events = pgTable(
  'events',
  {
    event: jsonb().notNull(),
    runId: text('run_id')
      .notNull()
      .references(() => runs.id),
    sequence: integer().notNull()
  },
  (table) => [
    primaryKey({ columns: [table.runId, table.sequence] }),
    check('events_sequence_check', sql`${table.sequence} > 0`)
  ]
)

export const approvals = pgTable(
  'approvals',
  {
    allowedDecisions: jsonb('allowed_decisions').$type<ApprovalDecision[]>().notNull(),
    decision: text().$type<ApprovalDecision>(),
    detail: jsonb().$type<JsonObject>().notNull(),
    id: text().primaryKey(),
    kind: text().$type<'command' | 'file-change'>().notNull(),
    nativeRequestId: jsonb('native_request_id').$type<string | number>().notNull(),
    runId: text('run_id')
      .notNull()
      .references(() => runs.id),
    status: text().$type<ApprovalStatus>().notNull()
  },
  (table) => [
    check('approvals_kind_check', sql`${table.kind} in ('command', 'file-change')`),
    check('approvals_status_check', sql`${table.status} in ('pending', 'responding', 'resolved', 'expired')`),
    check('approvals_decision_check', sql`${table.decision} in ('approve', 'deny')`),
    unique().on(table.runId, table.nativeRequestId)
  ]
)

export const inputRequests = pgTable(
  'input_requests',
  {
    answers: jsonb().$type<InputAnswers>(),
    id: text().primaryKey(),
    nativeRequestId: jsonb('native_request_id').$type<string | number>().notNull(),
    questions: jsonb().$type<InputQuestion[]>().notNull(),
    runId: text('run_id')
      .notNull()
      .references(() => runs.id),
    status: text().$type<InputRequest['status']>().notNull()
  },
  (table) => [
    unique().on(table.runId, table.nativeRequestId),
    check('input_status_check', sql`${table.status} in ('pending', 'responding', 'resolved', 'expired')`)
  ]
)
