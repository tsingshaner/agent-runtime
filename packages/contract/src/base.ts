// biome-ignore-all lint/style/useNamingConvention: Standard oRPC error codes.
import { oc } from '@orpc/contract'
import { openapi } from '@orpc/openapi'
import * as z from 'zod/mini'

import * as s from './schemas'

export const base = oc.meta(openapi({ inputStructure: 'detailed', requestBodyHint: 'json' })).errors({
  BAD_REQUEST: { message: 'Invalid input' },
  CONFLICT: { data: z.object({ code: z.string() }), message: 'Operation conflicts with current state' },
  FORBIDDEN: { message: 'Forbidden' },
  GONE: { message: 'Event history cleared' },
  INTERNAL_SERVER_ERROR: { message: 'Internal error' },
  NOT_FOUND: { message: 'Not found' },
  SERVICE_UNAVAILABLE: { message: 'Service unavailable' },
  UNAUTHORIZED: { message: 'Unauthorized' }
})
const params = z.strictObject({ id: s.text })
export const byId = z.object({ params })
export const withBody = <S extends z.ZodMiniType>(body: S) => z.object({ body })
export const idBody = <S extends z.ZodMiniType>(body: S) => z.object({ body, params })
export const query = <S extends z.ZodMiniType>(schema: S) => z.object({ query: schema })
export const idQuery = <S extends z.ZodMiniType>(schema: S) => z.object({ params, query: schema })
export const itemParams = z.strictObject({ id: s.text, item: s.text })
export const empty = z.strictObject({})
export const done = z.object({})
export const search = z.strictObject({ q: s.text })
