import * as z from 'zod/mini'

import { RuntimeError } from './errors'

import type { Json, JsonObject } from './types'

const NonEmptyStringSchema = z.string().check(z.minLength(1))
export const SessionIdSchema = NonEmptyStringSchema
export const ArchivedSchema = z.boolean()

/**
 * Check JSON compatibility while rejecting cycles and allowing repeated non-cyclic references.
 */
const isJson = (value: unknown, visiting = new WeakSet<object>()): value is Json => {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return true
  }
  if (typeof value === 'number') {
    return Number.isFinite(value)
  }
  if (typeof value !== 'object') {
    return false
  }
  if (visiting.has(value)) {
    return false
  }

  visiting.add(value)
  try {
    if (Array.isArray(value)) {
      return value.every((item) => isJson(item, visiting))
    }
    const prototype = Object.getPrototypeOf(value)
    return (
      (prototype === Object.prototype || prototype === null) &&
      Object.values(value).every((item) => isJson(item, visiting))
    )
  } finally {
    visiting.delete(value)
  }
}

export const JsonObjectSchema = z.custom<JsonObject>(
  (value) => value !== null && !Array.isArray(value) && typeof value === 'object' && isJson(value)
)

export const InsertSessionInputSchema = z.strictObject({
  cwd: NonEmptyStringSchema,
  id: NonEmptyStringSchema,
  model: z.optional(z.nullable(NonEmptyStringSchema)),
  nativeSessionId: NonEmptyStringSchema,
  options: JsonObjectSchema,
  projectId: NonEmptyStringSchema,
  runtime: NonEmptyStringSchema,
  title: NonEmptyStringSchema
})

export const PageInputSchema = z.strictObject({
  cursor: z.optional(z.string()),
  limit: z.prefault(z.int().check(z.minimum(1), z.maximum(200)), 50)
})

export const SessionFilterSchema = z.strictObject({
  archived: z.optional(ArchivedSchema),
  ...PageInputSchema.shape,
  projectId: z.optional(NonEmptyStringSchema),
  runtime: z.optional(NonEmptyStringSchema)
})

export const CursorSchema = z.strictObject({
  createdAt: z.iso.datetime({ offset: true }),
  id: NonEmptyStringSchema
})

export type InsertSessionInput = z.input<typeof InsertSessionInputSchema>
export type Cursor = z.output<typeof CursorSchema>

/**
 * Validate input with Zod Mini and expose a stable SDK validation error.
 *
 * @throws {@link RuntimeError} with INVALID_INPUT when validation fails.
 */
export const parseInput = <TSchema extends z.ZodMiniType>(schema: TSchema, input: unknown): z.output<TSchema> => {
  const result = z.safeParse(schema, input)
  if (!result.success) {
    throw new RuntimeError('INVALID_INPUT', 'Invalid input')
  }
  return result.data
}
