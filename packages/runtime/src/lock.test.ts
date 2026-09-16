import { access, mkdtemp, open, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test, vi } from 'vitest'

import { acquireDirectoryLock } from './lock'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, open: vi.fn(actual.open) }
})

describe('acquireDirectoryLock', () => {
  test('removes its lock when the final handle close fails', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'runtime-lock-'))
    const closeError = new Error('injected handle close failure')
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    vi.mocked(open).mockImplementationOnce(async (path, flags, mode) => {
      const handle = await actual.open(path, flags, mode)
      vi.spyOn(handle, 'close').mockRejectedValueOnce(closeError)
      return handle
    })

    try {
      await expect(acquireDirectoryLock(dir)).rejects.toBe(closeError)
      await expect(access(join(dir, '.manager.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(dir, { force: true, recursive: true })
    }
  })
})
