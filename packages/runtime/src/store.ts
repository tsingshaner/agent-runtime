import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { PGlite } from '@electric-sql/pglite'
import { and, defineRelations, desc, eq, getTableColumns, inArray, sql } from 'drizzle-orm'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'

import { RuntimeError } from './errors'
import { acquireDirectoryLock, type DirectoryLock } from './lock'
import * as schema from './schema'
import { runs, sessions } from './schema'
import {
  ArchivedSchema,
  type Cursor,
  CursorSchema,
  type InsertSessionInput,
  InsertSessionInputSchema,
  parseInput,
  SessionFilterSchema,
  SessionIdSchema
} from './validation'

import type { Page, Session, SessionFilter } from './types'

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

function encodeCursor(session: Session): string {
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

  close(): Promise<void> {
    this.closePromise ??= this.closeOwnedResources()
    return this.closePromise
  }

  private async closeOwnedResources(): Promise<void> {
    await this.client.close()
    await this.lock.release()
  }
}
