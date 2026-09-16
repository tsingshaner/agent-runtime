import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { PGlite } from '@electric-sql/pglite'
import { defineRelations } from 'drizzle-orm'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'

import { RuntimeError } from './errors'
import { acquireDirectoryLock, type DirectoryLock } from './lock'
import * as schema from './schema'

const migrationsFolder = fileURLToPath(new URL('../drizzle', import.meta.url))
const relations = defineRelations(schema)

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

  close(): Promise<void> {
    this.closePromise ??= this.closeOwnedResources()
    return this.closePromise
  }

  private async closeOwnedResources(): Promise<void> {
    await this.client.close()
    await this.lock.release()
  }
}
