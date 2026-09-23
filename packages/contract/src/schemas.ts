// biome-ignore-all lint/style/useNamingConvention: Memory gateway wire fields.
import * as v from 'valibot'

export const text = v.pipe(v.string(), v.minLength(1))
export const count = v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(Number.MAX_SAFE_INTEGER))
export const page = v.strictObject({
  cursor: v.optional(v.string()),
  limit: v.optional(v.pipe(count, v.minValue(1), v.maxValue(200)))
})
export const memoryPage = v.strictObject({ limit: page.entries.limit, offset: v.optional(count) })
export const content = v.strictObject({ content: v.string() })
export const document = v.strictObject({ content: v.string(), path: text })
export const ids = v.strictObject({ ids: v.pipe(v.array(text), v.minLength(1), v.maxLength(5000)) })
const fault = v.object({ code: v.string(), message: v.string() })
type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
const json: v.GenericSchema<Json> = v.lazy(() =>
  v.union([v.null(), v.boolean(), v.number(), v.string(), v.array(json), v.record(v.string(), json)])
)
const jsonObject = v.record(v.string(), json)
export const project = v.object({
  createdAt: v.string(),
  id: text,
  name: v.string(),
  updatedAt: v.string(),
  workingDirectories: v.array(v.string())
})
export const projectCreate = v.strictObject({
  id: v.optional(text),
  name: text,
  workingDirectories: v.optional(v.array(text))
})
export const projectUpdate = v.strictObject({ name: v.optional(text), workingDirectories: v.optional(v.array(text)) })
export const sessionCreate = v.strictObject({
  cwd: text,
  model: text,
  options: v.optional(jsonObject),
  projectId: text,
  runtime: text,
  title: v.optional(text)
})
export const session = v.object({
  activeRunId: v.nullable(v.string()),
  archived: v.boolean(),
  createdAt: v.string(),
  cwd: text,
  id: text,
  model: v.nullable(v.string()),
  nativeSessionId: text,
  options: jsonObject,
  projectId: text,
  runtime: text,
  title: v.string(),
  updatedAt: v.string()
})
export const run = v.object({
  createdAt: v.string(),
  endedAt: v.nullable(v.string()),
  error: v.nullable(fault),
  eventsCleared: v.boolean(),
  id: text,
  lastSequence: count,
  memoryError: v.nullable(fault),
  nativeTurnId: v.nullable(v.string()),
  requestId: v.nullable(v.string()),
  sessionId: text,
  status: v.picklist([
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
export const decision = v.picklist(['approve', 'deny'])
const interactionStatus = v.picklist(['pending', 'responding', 'resolved', 'expired'])
export const approval = v.object({
  allowedDecisions: v.array(decision),
  batchId: v.nullable(v.string()),
  batchIndex: v.nullable(count),
  decision: v.nullable(decision),
  detail: jsonObject,
  id: text,
  kind: v.picklist(['command', 'file-change', 'tool']),
  nativeRequestId: v.union([v.string(), v.number()]),
  runId: text,
  status: v.union([interactionStatus, v.literal('decided')])
})
export const answers = v.record(v.string(), v.array(v.string()))
export const inputRequest = v.object({
  answers: v.nullable(answers),
  id: text,
  nativeRequestId: v.union([v.string(), v.number()]),
  questions: v.array(
    v.object({
      header: v.string(),
      id: text,
      isOther: v.optional(v.boolean()),
      isSecret: v.optional(v.boolean()),
      options: v.optional(v.nullable(v.array(v.object({ description: v.string(), label: v.string() })))),
      question: v.string()
    })
  ),
  runId: text,
  status: interactionStatus
})
export const memoryWrite = v.object({
  assistant: v.string(),
  error: v.nullable(fault),
  projectId: text,
  runId: text,
  sessionId: text,
  status: v.picklist(['pending', 'accepted', 'failed', 'unknown']),
  user: v.string()
})
export const skill = v.object({
  description: v.string(),
  directory: v.string(),
  enabled: v.optional(v.boolean()),
  id: text,
  name: v.string()
})
const variable = v.pipe(v.string(), v.regex(/^[A-Za-z_][A-Za-z0-9_]*$/))
const mcpCommon = {
  name: v.pipe(text, v.regex(/^[a-zA-Z0-9_-]+$/)),
  timeoutMs: v.optional(v.pipe(count, v.minValue(10), v.maxValue(120000)), 10000)
}
const stdio = {
  ...mcpCommon,
  args: v.optional(v.array(v.string()), []),
  command: text,
  cwd: v.optional(text),
  env: v.optional(v.record(variable, variable), {}),
  transport: v.literal('stdio')
}
const http = {
  ...mcpCommon,
  headers: v.optional(v.record(text, variable), {}),
  transport: v.literal('http'),
  url: v.pipe(v.string(), v.url())
}
export const mcpConfig = v.variant('transport', [v.strictObject(stdio), v.strictObject(http)])
const resourceId = { enabled: v.optional(v.boolean()), id: text }
export const mcpServer = v.variant('transport', [
  v.object({ ...stdio, ...resourceId }),
  v.object({ ...http, ...resourceId })
])
export const tool = v.looseObject({
  description: v.optional(v.string()),
  inputSchema: v.looseObject({ type: v.literal('object') }),
  name: text
})
export const coreStatus = v.object({
  endpoint: v.string(),
  error: v.optional(fault),
  owned: v.boolean(),
  phase: v.picklist(['not_installed', 'stopped', 'starting', 'running', 'failed']),
  version: v.string()
})
const atomic = v.object({
  background: v.optional(v.string()),
  content: v.string(),
  created_at: v.string(),
  id: text,
  type: v.string(),
  updated_at: v.string()
})
export const atomicPage = v.object({ items: v.array(atomic), total: count })
export const atomicSearch = v.object({ items: v.array(v.object({ ...atomic.entries, score: v.number() })) })
export const atomicUpdate = v.object({ id: text, updated_at: v.string() })
export const deleted = v.object({ deleted_count: count })
export const conversations = v.object({
  messages: v.array(
    v.object({
      content: v.string(),
      id: v.optional(v.string()),
      role: v.picklist(['user', 'assistant', 'system']),
      timestamp: v.optional(v.string())
    })
  ),
  total: count
})
export const core = v.object({
  content: v.nullable(v.string()),
  created_at: v.nullable(v.string()),
  updated_at: v.nullable(v.string())
})
export const coreUpdated = v.object({ updated_at: v.string() })
export const paged = <S extends v.GenericSchema>(item: S) =>
  v.object({ items: v.array(item), nextCursor: v.nullable(v.string()) })
