import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { link, lstat, open, realpath, rename, rm } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

export class FileError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'FileError'
  }
}
const isMissingFile = (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ENOENT'
export const readRegularFile = async (path: string): Promise<string> => {
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    if (!(await handle.stat()).isFile()) {
      throw new FileError('INVALID_PATH', 'Expected a regular file')
    }
    return await handle.readFile('utf8')
  } catch (error) {
    if (isMissingFile(error)) {
      throw new FileError('NOT_FOUND', 'File not found')
    }
    if (error instanceof FileError) {
      throw error
    }
    throw new FileError('INVALID_PATH', 'File cannot be accessed safely')
  } finally {
    await handle?.close()
  }
}
export const atomicWrite = async (path: string, content: string, create = false): Promise<void> => {
  let mode = 0o600
  if (!create) {
    try {
      const existing = await lstat(path)
      if (!existing.isFile()) {
        throw new FileError('INVALID_PATH', 'Expected a regular file')
      }
      mode = existing.mode & 0o777
    } catch (error) {
      if (!isMissingFile(error)) {
        throw error
      }
    }
  }
  const temporary = `${path}.${randomUUID()}.tmp`
  const handle = await open(temporary, 'wx', 0o600)
  try {
    await handle.chmod(mode)
    await handle.writeFile(content)
    await handle.sync()
    await handle.close()
    if (create) {
      await link(temporary, path)
    } else {
      await rename(temporary, path)
    }
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
      throw new FileError('ALREADY_EXISTS', 'File already exists')
    }
    throw error
  } finally {
    await handle.close()
    await rm(temporary, { force: true })
  }
}
/** Reject supplied traversal and symlinks in an owner-controlled directory hierarchy. */
export const resourcePath = async (root: string, path: string): Promise<string> => {
  if (
    typeof path !== 'string' ||
    isAbsolute(path) ||
    path.includes('\\') ||
    path.includes('\0') ||
    path.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    throw new FileError('INVALID_PATH', 'Expected a relative file path')
  }
  if ((await realpath(root)) !== root || !(await lstat(root)).isDirectory()) {
    throw new FileError('INVALID_PATH', 'Directory changed')
  }
  let current = root
  for (const part of path.split('/')) {
    current = join(current, part)
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        throw new FileError('INVALID_PATH', 'Symbolic links are not supported')
      }
    } catch (error) {
      if (!isMissingFile(error)) {
        throw error
      }
    }
  }
  return current
}
