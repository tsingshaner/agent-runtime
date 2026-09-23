// cspell:ignore collab
import { type Json, RuntimeError } from '@qingshaner/runtime'
import * as z from 'zod/mini'

import type { InitializeResponse } from './schemas/InitializeResponse'
import type { AgentMessageDeltaNotification } from './schemas/v2/AgentMessageDeltaNotification'
import type { CommandExecutionRequestApprovalParams } from './schemas/v2/CommandExecutionRequestApprovalParams'
import type { CommandExecutionRequestApprovalResponse } from './schemas/v2/CommandExecutionRequestApprovalResponse'
import type { FileChangeRequestApprovalParams } from './schemas/v2/FileChangeRequestApprovalParams'
import type { FileChangeRequestApprovalResponse } from './schemas/v2/FileChangeRequestApprovalResponse'
import type { ItemCompletedNotification } from './schemas/v2/ItemCompletedNotification'
import type { ItemStartedNotification } from './schemas/v2/ItemStartedNotification'
import type { McpServerElicitationRequestParams } from './schemas/v2/McpServerElicitationRequestParams'
import type { McpServerElicitationRequestResponse } from './schemas/v2/McpServerElicitationRequestResponse'
import type { PermissionsRequestApprovalResponse } from './schemas/v2/PermissionsRequestApprovalResponse'
import type { ServerRequestResolvedNotification } from './schemas/v2/ServerRequestResolvedNotification'
import type { Thread } from './schemas/v2/Thread'
import type { ThreadItem } from './schemas/v2/ThreadItem'
import type { ThreadStartResponse } from './schemas/v2/ThreadStartResponse'
import type { ToolRequestUserInputParams } from './schemas/v2/ToolRequestUserInputParams'
import type { ToolRequestUserInputResponse } from './schemas/v2/ToolRequestUserInputResponse'
import type { Turn } from './schemas/v2/Turn'
import type { TurnError } from './schemas/v2/TurnError'

export const ApprovalResponseSchema = z.strictObject({
  decision: z.enum(['accept', 'decline'])
}) satisfies z.ZodMiniType<CommandExecutionRequestApprovalResponse & FileChangeRequestApprovalResponse, unknown>
export const UserInputSchema = z.object({
  autoResolutionMs: z.nullable(z.number()),
  isBlocking: z.boolean(),
  itemId: z.string(),
  questions: z
    .array(
      z.object({
        header: z.string(),
        id: z.string().check(z.minLength(1)),
        isOther: z.boolean(),
        isSecret: z.boolean(),
        options: z.nullable(z.array(z.object({ description: z.string(), label: z.string() }))),
        question: z.string().check(z.minLength(1))
      })
    )
    .check(
      z.minLength(1),
      z.refine((questions) => new Set(questions.map(({ id }) => id)).size === questions.length)
    ),
  threadId: z.string(),
  turnId: z.string()
}) satisfies z.ZodMiniType<ToolRequestUserInputParams, unknown>
export const UserInputResponseSchema = z.strictObject({
  answers: z.record(z.string(), z.strictObject({ answers: z.array(z.string()) }))
}) satisfies z.ZodMiniType<ToolRequestUserInputResponse, unknown>
export const EmptyAnswersSchema = z.strictObject({ answers: z.strictObject({}) }) satisfies z.ZodMiniType<
  ToolRequestUserInputResponse,
  unknown
>
export const DeclineElicitationSchema = z.strictObject({
  _meta: z.null(),
  action: z.literal('decline'),
  content: z.null()
}) satisfies z.ZodMiniType<McpServerElicitationRequestResponse, unknown>
export const NoPermissionsSchema = z.strictObject({
  permissions: z.strictObject({}),
  scope: z.literal('turn')
}) satisfies z.ZodMiniType<PermissionsRequestApprovalResponse, unknown>

const JsonSchema: z.ZodMiniType<Json, unknown> = z.lazy(() =>
  z.union([z.null(), z.boolean(), z.number(), z.string(), z.array(JsonSchema), z.record(z.string(), JsonSchema)])
)
const IdSchema = z.union([z.string(), z.int()])
const optionalVersion = { jsonrpc: z.optional(z.literal('2.0')) }
const ErrorSchema = z.object({
  code: z.int(),
  data: z.optional(JsonSchema),
  message: z.string()
})
const EnvelopeSchema = z.union([
  z.strictObject({ ...optionalVersion, id: IdSchema, result: JsonSchema }),
  z.strictObject({ ...optionalVersion, error: ErrorSchema, id: IdSchema }),
  z.strictObject({ ...optionalVersion, id: IdSchema, method: z.string(), params: z.prefault(JsonSchema, null) }),
  z.strictObject({
    ...optionalVersion,
    emittedAtMs: z.optional(z.int()),
    method: z.string(),
    params: z.prefault(JsonSchema, null)
  })
])

export type Frame =
  | { kind: 'response'; id: string | number; result: Json; error?: never }
  | { kind: 'response'; id: string | number; error: z.output<typeof ErrorSchema>; result?: never }
  | { kind: 'notification'; method: string; params: Json }
  | { kind: 'server-request'; id: string | number; method: string; params: Json }

const InitializeResponseSchema = z.object({
  codexHome: z.string(),
  platformFamily: z.string(),
  platformOs: z.string(),
  userAgent: z.string()
}) satisfies z.ZodMiniType<InitializeResponse, unknown>
export const ThreadResponseSchema = z.object({
  cwd: z.string(),
  model: z.string(),
  thread: z.object({ id: z.string() })
}) satisfies z.ZodMiniType<Pick<ThreadStartResponse, 'cwd' | 'model'> & { thread: Pick<Thread, 'id'> }, unknown>
const TurnErrorSchema = z.object({ message: z.string() }) satisfies z.ZodMiniType<Pick<TurnError, 'message'>, unknown>
const TurnSchema = z.object({
  error: z.nullable(TurnErrorSchema),
  id: z.string(),
  status: z.enum(['completed', 'interrupted', 'failed', 'inProgress'])
}) satisfies z.ZodMiniType<Pick<Turn, 'id' | 'status'> & { error: Pick<TurnError, 'message'> | null }, unknown>
export const TurnResponseSchema = z.object({ turn: TurnSchema })
export const TurnNotificationSchema = z.object({ threadId: z.string(), turn: TurnSchema })
export const DeltaSchema = z.object({
  delta: z.string(),
  itemId: z.string(),
  threadId: z.string(),
  turnId: z.string()
}) satisfies z.ZodMiniType<AgentMessageDeltaNotification, unknown>

const AgentMessageSchema = z.object({
  id: z.string(),
  phase: z.nullable(z.enum(['commentary', 'final_answer'])),
  text: z.string(),
  type: z.literal('agentMessage')
}) satisfies z.ZodMiniType<
  Pick<Extract<ThreadItem, { type: 'agentMessage' }>, 'type' | 'id' | 'text' | 'phase'>,
  unknown
>
const CommandItemSchema = z.object({
  aggregatedOutput: z.nullable(z.string()),
  command: z.string(),
  cwd: z.string(),
  exitCode: z.nullable(z.number()),
  id: z.string(),
  status: z.enum(['inProgress', 'completed', 'failed', 'declined']),
  type: z.literal('commandExecution')
}) satisfies z.ZodMiniType<
  Pick<
    Extract<ThreadItem, { type: 'commandExecution' }>,
    'type' | 'id' | 'command' | 'cwd' | 'status' | 'aggregatedOutput' | 'exitCode'
  >,
  unknown
>
const FileItemSchema = z.object({
  changes: z.array(
    z.object({
      diff: z.string(),
      kind: z.discriminatedUnion('type', [
        z.object({ type: z.literal('add') }),
        z.object({ type: z.literal('delete') }),
        // biome-ignore lint/style/useNamingConvention: Codex protocol field name.
        z.object({ move_path: z.nullable(z.string()), type: z.literal('update') })
      ]),
      path: z.string()
    })
  ),
  id: z.string(),
  status: z.enum(['inProgress', 'completed', 'failed', 'declined']),
  type: z.literal('fileChange')
}) satisfies z.ZodMiniType<Extract<ThreadItem, { type: 'fileChange' }>, unknown>
const McpItemSchema = z.object({
  arguments: JsonSchema,
  error: z.nullable(z.object({ message: z.string() })),
  id: z.string(),
  result: z.nullable(
    z.object({ _meta: z.nullable(JsonSchema), content: z.array(JsonSchema), structuredContent: z.nullable(JsonSchema) })
  ),
  server: z.string(),
  status: z.enum(['inProgress', 'completed', 'failed']),
  tool: z.string(),
  type: z.literal('mcpToolCall')
}) satisfies z.ZodMiniType<
  Pick<
    Extract<ThreadItem, { type: 'mcpToolCall' }>,
    'type' | 'id' | 'server' | 'tool' | 'arguments' | 'status' | 'result' | 'error'
  >,
  unknown
>
export const ItemSchema = z.union([
  AgentMessageSchema,
  CommandItemSchema,
  FileItemSchema,
  McpItemSchema,
  z.object({
    id: z.string(),
    type: z.enum([
      'userMessage',
      'hookPrompt',
      'functionCallOutput',
      'plan',
      'reasoning',
      'dynamicToolCall',
      'collabAgentToolCall',
      'subAgentActivity',
      'webSearch',
      'imageView',
      'sleep',
      'imageGeneration',
      'enteredReviewMode',
      'exitedReviewMode',
      'contextCompaction'
    ])
  })
])
export const ItemNotificationSchema = z.object({
  item: ItemSchema,
  threadId: z.string(),
  turnId: z.string()
}) satisfies z.ZodMiniType<
  Pick<ItemStartedNotification & ItemCompletedNotification, 'threadId' | 'turnId'> & {
    item: Pick<ThreadItem, 'type' | 'id'>
  },
  unknown
>
const AvailableDecisionsSchema = z.optional(
  z.nullable(
    z.array(z.union([z.enum(['accept', 'acceptForSession', 'decline', 'cancel']), z.record(z.string(), JsonSchema)]))
  )
)
export const CommandApprovalSchema = z.object({
  availableDecisions: AvailableDecisionsSchema,
  command: z.optional(z.nullable(z.string())),
  cwd: z.optional(z.nullable(z.string())),
  itemId: z.string(),
  reason: z.optional(z.nullable(z.string())),
  threadId: z.string(),
  turnId: z.string()
}) satisfies z.ZodMiniType<
  Pick<CommandExecutionRequestApprovalParams, 'threadId' | 'turnId' | 'itemId' | 'command' | 'cwd' | 'reason'>,
  unknown
>
export const FileApprovalSchema = z.object({
  availableDecisions: AvailableDecisionsSchema,
  grantRoot: z.optional(z.nullable(z.string())),
  itemId: z.string(),
  reason: z.optional(z.nullable(z.string())),
  threadId: z.string(),
  turnId: z.string()
}) satisfies z.ZodMiniType<
  Pick<FileChangeRequestApprovalParams, 'threadId' | 'turnId' | 'itemId' | 'reason' | 'grantRoot'>,
  unknown
>
export const RequestResolvedSchema = z.object({ requestId: IdSchema, threadId: z.string() }) satisfies z.ZodMiniType<
  ServerRequestResolvedNotification,
  unknown
>
const ErrorNotificationSchema = z.object({
  error: TurnErrorSchema,
  threadId: z.string(),
  turnId: z.string(),
  willRetry: z.boolean()
})

const parameterSchemas: Record<string, z.ZodMiniType> = {
  error: ErrorNotificationSchema,
  'item/agentMessage/delta': DeltaSchema,
  'item/commandExecution/outputDelta': DeltaSchema,
  'item/commandExecution/requestApproval': CommandApprovalSchema,
  'item/completed': ItemNotificationSchema,
  'item/fileChange/outputDelta': DeltaSchema,
  'item/fileChange/requestApproval': FileApprovalSchema,
  'item/started': ItemNotificationSchema,
  'item/tool/requestUserInput': UserInputSchema,
  'serverRequest/resolved': RequestResolvedSchema,
  'turn/completed': TurnNotificationSchema,
  'turn/started': TurnNotificationSchema
}

/**
 * Validate a native payload and normalize schema failures to PROTOCOL_ERROR.
 */
export const parseProtocol = <T extends z.ZodMiniType>(schema: T, value: unknown): z.output<T> => {
  const result = z.safeParse(schema, value)
  if (!result.success) {
    throw new RuntimeError('PROTOCOL_ERROR', 'Invalid app-server protocol frame')
  }
  return result.data
}

/**
 * Validate a JSON-RPC envelope and classify responses, notifications, and server requests.
 */
export const parseFrame = (value: unknown): Frame => {
  const frame = parseProtocol(EnvelopeSchema, value)
  if ('method' in frame) {
    const schema = Object.hasOwn(parameterSchemas, frame.method) ? parameterSchemas[frame.method] : undefined
    if (schema) {
      parseProtocol(schema, frame.params)
    }
    return 'id' in frame
      ? { id: frame.id, kind: 'server-request', method: frame.method, params: frame.params }
      : { kind: 'notification', method: frame.method, params: frame.params }
  }
  return 'error' in frame
    ? { error: frame.error, id: frame.id, kind: 'response' }
    : { id: frame.id, kind: 'response', result: frame.result }
}

/**
 * Validate supported method results against their native response schemas.
 */
export const parseResult = (method: string, value: Json): Json => {
  switch (method) {
    case 'initialize':
      return parseProtocol(InitializeResponseSchema, value)
    case 'thread/start':
    case 'thread/resume':
      return parseProtocol(ThreadResponseSchema, value)
    case 'turn/start':
      return parseProtocol(TurnResponseSchema, value)
    case 'turn/interrupt':
      return parseProtocol(z.object({}), value)
    default:
      return value
  }
}

export const ElicitationApprovalSchema = z.object({
  message: z.string(),
  mode: z.enum(['form', 'openai/form', 'openaiForm']),
  requestedSchema: z.object({
    properties: z.strictObject({}),
    required: z.optional(z.array(z.string()).check(z.maxLength(0))),
    type: z.literal('object')
  }),
  serverName: z.literal('project_resources'),
  threadId: z.string(),
  turnId: z.nullable(z.string())
}) satisfies z.ZodMiniType<
  Pick<McpServerElicitationRequestParams, 'threadId' | 'turnId' | 'serverName' | 'mode' | 'message'>,
  unknown
>
export const ElicitationResponseSchema = z.strictObject({
  _meta: z.null(),
  action: z.enum(['accept', 'decline']),
  content: z.nullable(z.strictObject({}))
}) satisfies z.ZodMiniType<McpServerElicitationRequestResponse, unknown>
