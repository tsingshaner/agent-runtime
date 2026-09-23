import { openapi } from '@orpc/openapi'
import * as z from 'zod/mini'

import { base } from './base'

export const health = base
  .meta(
    openapi({
      description: 'Returns readiness for the authenticated local service.',
      method: 'GET',
      operationId: 'getHealth',
      path: '/health',
      summary: 'Check service readiness',
      tags: ['Health']
    })
  )
  .output(z.object({ status: z.literal('ready') }))
