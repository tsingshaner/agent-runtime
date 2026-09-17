import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PGlite } from '@electric-sql/pglite'
import { sql } from 'drizzle-orm'
import { describe, expect, test, vi } from 'vitest'

import { acquireDirectoryLock } from './lock'
import { SessionStore } from './store'

const seedMigration = async (dataDir: string, name: string | null): Promise<void> => {
  const client = await PGlite.create(join(dataDir, 'pgdata'), { relaxedDurability: false })
  try {
    await client.query('insert into drizzle.__drizzle_migrations (hash, created_at, name) values ($1, $2, $3)', [
      'unknown',
      0,
      name
    ])
  } finally {
    await client.close()
  }
}

const tryAcquireDirectory = async (dataDir: string): Promise<{ error: unknown } | { lock: unknown }> => {
  const result = await acquireDirectoryLock(dataDir).then(
    (lock) => ({ lock }),
    (error: unknown) => ({ error })
  )

  if ('lock' in result) {
    await result.lock.release()
  }
  return result
}

describe('SessionStore ownership', () => {
  test('preserves the native mapping after reopening', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'runtime-store-'))
    let store = await SessionStore.open(dir)

    try {
      await store.insertSession({
        cwd: dir,
        id: 's1',
        nativeSessionId: 'native-1',
        options: { model: 'test-model' },
        projectId: 'p1',
        runtime: 'codex',
        title: 'first'
      })
      await store.close()
      store = await SessionStore.open(dir)

      await expect(store.getSession('s1')).resolves.toMatchObject({
        activeRunId: null,
        id: 's1',
        nativeSessionId: 'native-1',
        options: { model: 'test-model' }
      })
    } finally {
      await store.close()
      await rm(dir, { force: true, recursive: true })
    }
  })

  test('rejects a second owner until the first closes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'runtime-store-'))
    const first = await SessionStore.open(dir)

    try {
      await expect(SessionStore.open(dir)).rejects.toMatchObject({ code: 'DATA_DIR_BUSY' })

      await first.close()
      const reopened = await SessionStore.open(dir)
      await reopened.close()
    } finally {
      await first.close()
      await rm(dir, { force: true, recursive: true })
    }
  })

  test('treats symbolic-link aliases as the same directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-store-'))
    const dir = join(root, 'data')
    const alias = join(root, 'alias')
    const first = await SessionStore.open(dir)

    try {
      await symlink(dir, alias)
      await expect(SessionStore.open(alias)).rejects.toMatchObject({ code: 'DATA_DIR_BUSY' })
    } finally {
      await first.close()
      await rm(root, { force: true, recursive: true })
    }
  })

  test('rejects a lock held by another process', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'runtime-store-'))
    const child = spawn(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        `
          import { open, realpath, unlink } from 'node:fs/promises'
          import { hostname } from 'node:os'
          import { join } from 'node:path'

          const path = join(await realpath(process.argv[1]), '.manager.lock')
          const handle = await open(path, 'wx', 0o600)
          await handle.writeFile(JSON.stringify({ pid: process.pid, hostname: hostname(), token: 'child' }))
          await handle.close()
          process.stdout.write('ready\\n')
          process.stdin.resume()
          await new Promise((resolve) => process.stdin.once('end', resolve))
          await unlink(path)
        `,
        dir
      ],
      { stdio: ['pipe', 'pipe', 'inherit'] }
    )

    try {
      let output = ''
      for await (const chunk of child.stdout) {
        output += chunk.toString()
        if (output.includes('ready\n')) {
          break
        }
      }

      await expect(SessionStore.open(dir)).rejects.toMatchObject({ code: 'DATA_DIR_BUSY' })
    } finally {
      child.stdin.end()
      await once(child, 'exit')
      await rm(dir, { force: true, recursive: true })
    }
  })

  test('close is idempotent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'runtime-store-'))
    const store = await SessionStore.open(dir)

    try {
      await Promise.all([store.close(), store.close()])
    } finally {
      await store.close()
      await rm(dir, { force: true, recursive: true })
    }
  })

  test('retains ownership when database shutdown rejects', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'runtime-store-'))
    const store = await SessionStore.open(dir)
    const shutdownError = new Error('injected database shutdown failure')
    const realClose = PGlite.prototype.close
    const closeSpy = vi.spyOn(PGlite.prototype, 'close').mockImplementationOnce(async function (this: PGlite) {
      await realClose.call(this)
      throw shutdownError
    })

    try {
      await expect(store.close()).rejects.toBe(shutdownError)
      await expect(tryAcquireDirectory(dir)).resolves.toMatchObject({ error: { code: 'DATA_DIR_BUSY' } })
    } finally {
      closeSpy.mockRestore()
      await rm(dir, { force: true, recursive: true })
    }
  })

  test('reopens a migrated database', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'runtime-store-'))
    const first = await SessionStore.open(dir)

    try {
      await first.close()
      const reopened = await SessionStore.open(dir)
      try {
        await expect(reopened.db.execute(sql`select count(*) from sessions`)).resolves.toBeDefined()
      } finally {
        await reopened.close()
      }
    } finally {
      await first.close()
      await rm(dir, { force: true, recursive: true })
    }
  })
})

describe('SessionStore migrations', () => {
  test('rejects migration records unknown to this package', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'runtime-store-'))
    const store = await SessionStore.open(dir)

    try {
      await store.close()
      await seedMigration(dir, '20990101000000_future_schema')

      await expect(SessionStore.open(dir)).rejects.toMatchObject({ code: 'UNKNOWN_MIGRATION' })
    } finally {
      await store.close()
      await rm(dir, { force: true, recursive: true })
    }
  })

  test('releases ownership when migration validation fails', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'runtime-store-'))
    const store = await SessionStore.open(dir)

    try {
      await store.close()
      await seedMigration(dir, null)

      await expect(SessionStore.open(dir)).rejects.toMatchObject({ code: 'UNKNOWN_MIGRATION' })
      await expect(SessionStore.open(dir)).rejects.toMatchObject({ code: 'UNKNOWN_MIGRATION' })
    } finally {
      await store.close()
      await rm(dir, { force: true, recursive: true })
    }
  })

  test('retains ownership and both errors when failed-open shutdown rejects', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'runtime-store-'))
    const store = await SessionStore.open(dir)
    const shutdownError = new Error('injected database shutdown failure')
    const realClose = PGlite.prototype.close

    try {
      await store.close()
      await seedMigration(dir, '20990101000000_future_schema')
      const closeSpy = vi.spyOn(PGlite.prototype, 'close').mockImplementationOnce(async function (this: PGlite) {
        await realClose.call(this)
        throw shutdownError
      })

      let openError: unknown
      try {
        await SessionStore.open(dir)
      } catch (error) {
        openError = error
      } finally {
        closeSpy.mockRestore()
      }

      expect(openError).toBeInstanceOf(AggregateError)
      expect((openError as AggregateError).errors).toEqual([
        expect.objectContaining({ code: 'UNKNOWN_MIGRATION' }),
        shutdownError
      ])
      await expect(tryAcquireDirectory(dir)).resolves.toMatchObject({ error: { code: 'DATA_DIR_BUSY' } })
    } finally {
      await store.close()
      await rm(dir, { force: true, recursive: true })
    }
  })
})
