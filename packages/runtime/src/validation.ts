import * as v from 'valibot'

import { RuntimeError } from './errors'

import type { Json, JsonObject } from './types'

const NonEmptyStringSchema = v.pipe(v.string(), v.minLength(1))
export const SessionIdSchema = NonEmptyStringSchema
export const ArchivedSchema = v.boolean()

function isJson(value: unknown): value is Json {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return true
  }
  if (typeof value === 'number') {
    return Number.isFinite(value)
  }
  if (Array.isArray(value)) {
    return value.every(isJson)
  }
  if (typeof value !== 'object') {
    return false
  }
  const prototype = Object.getPrototypeOf(value)
  return (prototype === Object.prototype || prototype === null) && Object.values(value).every(isJson)
}

export const JsonObjectSchema = v.custom<JsonObject>(
  (value) => value !== null && !Array.isArray(value) && typeof value === 'object' && isJson(value)
)

export const InsertSessionInputSchema = v.strictObject({
  cwd: NonEmptyStringSchema,
  id: NonEmptyStringSchema,
  nativeSessionId: NonEmptyStringSchema,
  options: JsonObjectSchema,
  projectId: NonEmptyStringSchema,
  runtime: NonEmptyStringSchema,
  title: NonEmptyStringSchema
})

export const PageInputSchema = v.strictObject({
  cursor: v.optional(v.string()),
  limit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(200)), 50)
})

export const SessionFilterSchema = v.strictObject({
  archived: v.optional(ArchivedSchema),
  ...PageInputSchema.entries,
  projectId: v.optional(NonEmptyStringSchema),
  runtime: v.optional(NonEmptyStringSchema)
})

export const CursorSchema = v.strictObject({
  createdAt: v.pipe(v.string(), v.isoTimestamp()),
  id: NonEmptyStringSchema
})

export type InsertSessionInput = v.InferOutput<typeof InsertSessionInputSchema>
export type PageInput = v.InferOutput<typeof PageInputSchema>
export type SessionFilterInput = v.InferOutput<typeof SessionFilterSchema>
export type Cursor = v.InferOutput<typeof CursorSchema>

export function parseInput<TSchema extends v.GenericSchema>(schema: TSchema, input: unknown): v.InferOutput<TSchema> {
  const result = v.safeParse(schema, input)
  if (!result.success) {
    throw new RuntimeError('INVALID_INPUT', 'Invalid input')
  }
  return result.output
}
