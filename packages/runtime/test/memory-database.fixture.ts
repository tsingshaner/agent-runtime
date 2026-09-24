import { PGlite } from '@electric-sql/pglite'
import { beforeAll, vi } from 'vitest'

/** Use real in-memory databases in this suite; keep restart and migration suites on disk. */
export const setupMemoryDatabase = (): void => {
  const create = PGlite.create.bind(PGlite)
  beforeAll(() => {
    // Preserve PGlite's internal initdb options when it calls create with an options object.
    const spy = vi
      .spyOn(PGlite, 'create')
      .mockImplementation((dataDir, options) => create(typeof dataDir === 'string' ? 'memory://' : dataDir, options))
    return () => spy.mockRestore()
  })
}
