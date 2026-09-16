import { randomUUID } from 'node:crypto'
import { type FileHandle, mkdir, open, readFile, realpath, unlink } from 'node:fs/promises'
import { hostname } from 'node:os'
import { join } from 'node:path'

import { RuntimeError } from './errors'

export interface DirectoryLock {
  path: string
  release(): Promise<void>
}

export async function acquireDirectoryLock(dataDir: string): Promise<DirectoryLock> {
  await mkdir(dataDir, { mode: 0o700, recursive: true })
  const canonicalDir = await realpath(dataDir)
  const path = join(canonicalDir, '.manager.lock')
  const token = randomUUID()
  let handle: FileHandle | undefined

  try {
    handle = await open(path, 'wx', 0o600)
    await handle.writeFile(JSON.stringify({ hostname: hostname(), pid: process.pid, token }))
  } catch (error) {
    await handle?.close().catch(() => undefined)
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new RuntimeError('DATA_DIR_BUSY', `Data directory is already owned: ${canonicalDir}`, {
        cause: error
      })
    }
    if (handle) {
      await unlink(path).catch(() => undefined)
    }
    throw error
  }

  await handle.close()
  let released = false

  return {
    path,
    async release() {
      if (released) {
        return
      }
      released = true

      const contents = await readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') {
          return undefined
        }
        throw error
      })
      if (!contents) {
        return
      }

      try {
        if ((JSON.parse(contents) as { token?: unknown }).token !== token) {
          return
        }
      } catch {
        return
      }

      await unlink(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') {
          throw error
        }
      })
    }
  }
}
