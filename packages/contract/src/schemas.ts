// biome-ignore-all lint/style/useNamingConvention: Memory gateway wire fields.
import * as z from 'zod/mini'

export const text = z.string().check(z.minLength(1))
export const count = z.int().check(z.minimum(0), z.maximum(Number.MAX_SAFE_INTEGER))
export const page = z.strictObject({
  cursor: z.optional(z.string()),
  limit: z.optional(count.check(z.minimum(1), z.maximum(200)))
})
export const memoryPage = z.strictObject({ limit: page.shape.limit, offset: z.optional(count) })
export const content = z.strictObject({ content: z.string() })
export const document = z.strictObject({ content: z.string(), path: text })
export const ids = z.strictObject({ ids: z.array(text).check(z.minLength(1), z.maxLength(5000)) })
const fault = z.object({ code: z.string(), message: z.string() })
type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
const json: z.ZodMiniType<Json, Json> = z.lazy(() =>
  z.union([z.null(), z.boolean(), z.number(), z.string(), z.array(json), z.record(z.string(), json)])
)
const jsonObject = z.record(z.string(), json)
export const project = z.object({
  createdAt: z.string(),
  id: text,
  name: z.string(),
  updatedAt: z.string(),
  workingDirectories: z.array(z.string())
})
export const projectCreate = z.strictObject({
  id: z.optional(text),
  name: text,
  workingDirectories: z.optional(z.array(text))
})
export const projectUpdate = z.strictObject({ name: z.optional(text), workingDirectories: z.optional(z.array(text)) })
export const sessionCreate = z.strictObject({
  cwd: text,
  model: text,
  options: z.optional(jsonObject),
  projectId: text,
  runtime: text,
  title: z.optional(text)
})
export const session = z.object({
  activeRunId: z.nullable(z.string()),
  archived: z.boolean(),
  createdAt: z.string(),
  cwd: text,
  id: text,
  model: z.nullable(z.string()),
  nativeSessionId: text,
  options: jsonObject,
  projectId: text,
  runtime: text,
  title: z.string(),
  updatedAt: z.string()
})
export const run = z.object({
  createdAt: z.string(),
  endedAt: z.nullable(z.string()),
  error: z.nullable(fault),
  eventsCleared: z.boolean(),
  id: text,
  lastSequence: count,
  memoryError: z.nullable(fault),
  nativeTurnId: z.nullable(z.string()),
  requestId: z.nullable(z.string()),
  sessionId: text,
  status: z.enum([
    'starting',
    'running',
    'waiting_approval',
    'waiting_input',
    'cancelling',
    'succeeded',
    'failed',
    'cancelled',
    'interrupted'
  ])
})
export const decision = z.enum(['approve', 'deny'])
const interactionStatus = z.enum(['pending', 'responding', 'resolved', 'expired'])
export const approval = z.object({
  allowedDecisions: z.array(decision),
  batchId: z.nullable(z.string()),
  batchIndex: z.nullable(count),
  decision: z.nullable(decision),
  detail: jsonObject,
  id: text,
  kind: z.enum(['command', 'file-change', 'tool']),
  nativeRequestId: z.union([z.string(), z.number()]),
  runId: text,
  status: z.union([interactionStatus, z.literal('decided')])
})
export const answers = z.record(z.string(), z.array(z.string()))
export const inputRequest = z.object({
  answers: z.nullable(answers),
  id: text,
  nativeRequestId: z.union([z.string(), z.number()]),
  questions: z.array(
    z.object({
      header: z.string(),
      id: text,
      isOther: z.optional(z.boolean()),
      isSecret: z.optional(z.boolean()),
      options: z.optional(z.nullable(z.array(z.object({ description: z.string(), label: z.string() })))),
      question: z.string()
    })
  ),
  runId: text,
  status: interactionStatus
})
export const memoryWrite = z.object({
  assistant: z.string(),
  error: z.nullable(fault),
  projectId: text,
  runId: text,
  sessionId: text,
  status: z.enum(['pending', 'accepted', 'failed', 'unknown']),
  user: z.string()
})
export const skill = z.object({
  description: z.string(),
  directory: z.string(),
  enabled: z.optional(z.boolean()),
  id: text,
  name: z.string()
})
const variable = z.string().check(z.regex(/^[A-Za-z_][A-Za-z0-9_]*$/))
const mcpCommon = {
  name: text.check(z.regex(/^[a-zA-Z0-9_-]+$/)),
  timeoutMs: z.prefault(count.check(z.minimum(10), z.maximum(120000)), 10000)
}
const stdio = {
  ...mcpCommon,
  args: z.prefault(z.array(z.string()), []),
  command: text,
  cwd: z.optional(text),
  env: z.prefault(z.record(variable, variable), {}),
  transport: z.literal('stdio')
}
const http = {
  ...mcpCommon,
  headers: z.prefault(z.record(text, variable), {}),
  transport: z.literal('http'),
  url: z.url()
}
export const mcpConfig = z.discriminatedUnion('transport', [z.strictObject(stdio), z.strictObject(http)])
const resourceId = { enabled: z.optional(z.boolean()), id: text }
export const mcpServer = z.discriminatedUnion('transport', [
  z.object({ ...stdio, ...resourceId }),
  z.object({ ...http, ...resourceId })
])
export const tool = z.looseObject({
  description: z.optional(z.string()),
  inputSchema: z.looseObject({ type: z.literal('object') }),
  name: text
})
export const coreStatus = z.object({
  endpoint: z.string(),
  error: z.optional(fault),
  owned: z.boolean(),
  phase: z.enum(['not_installed', 'stopped', 'starting', 'running', 'failed']),
  version: z.string()
})
const atomic = z.object({
  background: z.optional(z.string()),
  content: z.string(),
  created_at: z.string(),
  id: text,
  type: z.string(),
  updated_at: z.string()
})
export const atomicPage = z.object({ items: z.array(atomic), total: count })
export const atomicSearch = z.object({ items: z.array(z.object({ ...atomic.shape, score: z.number() })) })
export const atomicUpdate = z.object({ id: text, updated_at: z.string() })
export const deleted = z.object({ deleted_count: count })
export const conversations = z.object({
  messages: z.array(
    z.object({
      content: z.string(),
      id: z.optional(z.string()),
      role: z.enum(['user', 'assistant', 'system']),
      timestamp: z.optional(z.string())
    })
  ),
  total: count
})
export const core = z.object({
  content: z.nullable(z.string()),
  created_at: z.nullable(z.string()),
  updated_at: z.nullable(z.string())
})
export const coreUpdated = z.object({ updated_at: z.string() })
export const paged = <S extends z.ZodMiniType>(item: S) =>
  z.object({ items: z.array(item), nextCursor: z.nullable(z.string()) })
