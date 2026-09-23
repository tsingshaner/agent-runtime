import { openapi } from '@orpc/openapi'
import * as z from 'zod/mini'

import { base, empty, withBody } from './base'
import * as s from './schemas'

const memoryCoreBase = base.meta(openapi({ tags: ['Memory Core'] }))

export const memoryCore = {
  install: memoryCoreBase
    .meta(
      openapi({
        description:
          'Explicitly installs the pinned, verified MemoryCore version. An optional archivePath selects a local archive; installation does not start the service.',
        method: 'POST',
        operationId: 'installMemoryCore',
        path: '/memory-core/install',
        summary: 'Install MemoryCore'
      })
    )
    .input(withBody(z.strictObject({ archivePath: z.optional(s.text) })))
    .output(s.coreStatus),
  start: memoryCoreBase
    .meta(
      openapi({
        description:
          'Starts the installed service owned by this application and waits for health readiness. Does not implicitly install or upgrade it.',
        method: 'POST',
        operationId: 'startMemoryCore',
        path: '/memory-core/start',
        summary: 'Start MemoryCore'
      })
    )
    .input(withBody(empty))
    .output(s.coreStatus),
  status: memoryCoreBase
    .meta(
      openapi({
        description:
          'Returns installation and process state, ownership, endpoint, version and any safe lifecycle error.',
        method: 'GET',
        operationId: 'getMemoryCoreStatus',
        path: '/memory-core',
        summary: 'Get MemoryCore status'
      })
    )
    .output(s.coreStatus),
  stop: memoryCoreBase
    .meta(
      openapi({
        description:
          'Stops only the process owned by this application, preserves persisted data and returns the resulting status.',
        method: 'POST',
        operationId: 'stopMemoryCore',
        path: '/memory-core/stop',
        summary: 'Stop MemoryCore'
      })
    )
    .input(withBody(empty))
    .output(s.coreStatus)
}
