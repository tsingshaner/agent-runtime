// cspell:ignore collab
import { type Json, RuntimeError } from '@qingshaner/runtime'
import * as v from 'valibot'

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

export const ApprovalResponseSchema = v.strictObject({
  decision: v.picklist(['accept', 'decline'])
}) satisfies v.GenericSchema<unknown, CommandExecutionRequestApprovalResponse & FileChangeRequestApprovalResponse>
export const UserInputSchema = v.object({
  autoResolutionMs: v.nullable(v.number()),
  isBlocking: v.boolean(),
  itemId: v.string(),
  questions: v.pipe(
    v.array(
      v.object({
        header: v.string(),
        id: v.pipe(v.string(), v.minLength(1)),
        isOther: v.boolean(),
        isSecret: v.boolean(),
        options: v.nullable(v.array(v.object({ description: v.string(), label: v.string() }))),
        question: v.pipe(v.string(), v.minLength(1))
      })
    ),
    v.minLength(1),
    v.check((questions) => new Set(questions.map(({ id }) => id)).size === questions.length)
  ),
  threadId: v.string(),
  turnId: v.string()
}) satisfies v.GenericSchema<unknown, ToolRequestUserInputParams>
export const UserInputResponseSchema = v.strictObject({
  answers: v.record(v.string(), v.strictObject({ answers: v.array(v.string()) }))
}) satisfies v.GenericSchema<unknown, ToolRequestUserInputResponse>
export const EmptyAnswersSchema = v.strictObject({ answers: v.strictObject({}) }) satisfies v.GenericSchema<
  unknown,
  ToolRequestUserInputResponse
>
export const DeclineElicitationSchema = v.strictObject({
  _meta: v.null(),
  action: v.literal('decline'),
  content: v.null()
}) satisfies v.GenericSchema<unknown, McpServerElicitationRequestResponse>
export const NoPermissionsSchema = v.strictObject({
  permissions: v.strictObject({}),
  scope: v.literal('turn')
}) satisfies v.GenericSchema<unknown, PermissionsRequestApprovalResponse>

const JsonSchema: v.GenericSchema<unknown, Json> = v.lazy(() =>
  v.union([
    v.null(),
    v.boolean(),
    v.pipe(v.number(), v.finite()),
    v.string(),
    v.array(JsonSchema),
    v.record(v.string(), JsonSchema)
  ])
)
const IdSchema = v.union([v.string(), v.pipe(v.number(), v.safeInteger())])
const optionalVersion = { jsonrpc: v.optional(v.literal('2.0')) }
const ErrorSchema = v.object({
  code: v.pipe(v.number(), v.integer()),
  data: v.optional(JsonSchema),
  message: v.string()
})
const EnvelopeSchema = v.union([
  v.strictObject({ ...optionalVersion, id: IdSchema, result: JsonSchema }),
  v.strictObject({ ...optionalVersion, error: ErrorSchema, id: IdSchema }),
  v.strictObject({ ...optionalVersion, id: IdSchema, method: v.string(), params: v.optional(JsonSchema, null) }),
  v.strictObject({
    ...optionalVersion,
    emittedAtMs: v.optional(v.pipe(v.number(), v.safeInteger())),
    method: v.string(),
    params: v.optional(JsonSchema, null)
  })
])

export type Frame =
  | { kind: 'response'; id: string | number; result: Json; error?: never }
  | { kind: 'response'; id: string | number; error: v.InferOutput<typeof ErrorSchema>; result?: never }
  | { kind: 'notification'; method: string; params: Json }
  | { kind: 'server-request'; id: string | number; method: string; params: Json }

const InitializeResponseSchema = v.object({
  codexHome: v.string(),
  platformFamily: v.string(),
  platformOs: v.string(),
  userAgent: v.string()
}) satisfies v.GenericSchema<unknown, InitializeResponse>
export const ThreadResponseSchema = v.object({
  cwd: v.string(),
  model: v.string(),
  thread: v.object({ id: v.string() })
}) satisfies v.GenericSchema<unknown, Pick<ThreadStartResponse, 'cwd' | 'model'> & { thread: Pick<Thread, 'id'> }>
const TurnErrorSchema = v.object({ message: v.string() }) satisfies v.GenericSchema<unknown, Pick<TurnError, 'message'>>
const TurnSchema = v.object({
  error: v.nullable(TurnErrorSchema),
  id: v.string(),
  status: v.picklist(['completed', 'interrupted', 'failed', 'inProgress'])
}) satisfies v.GenericSchema<unknown, Pick<Turn, 'id' | 'status'> & { error: Pick<TurnError, 'message'> | null }>
export const TurnResponseSchema = v.object({ turn: TurnSchema })
export const TurnNotificationSchema = v.object({ threadId: v.string(), turn: TurnSchema })
export const DeltaSchema = v.object({
  delta: v.string(),
  itemId: v.string(),
  threadId: v.string(),
  turnId: v.string()
}) satisfies v.GenericSchema<unknown, AgentMessageDeltaNotification>

const AgentMessageSchema = v.object({
  id: v.string(),
  phase: v.nullable(v.picklist(['commentary', 'final_answer'])),
  text: v.string(),
  type: v.literal('agentMessage')
}) satisfies v.GenericSchema<
  unknown,
  Pick<Extract<ThreadItem, { type: 'agentMessage' }>, 'type' | 'id' | 'text' | 'phase'>
>
const CommandItemSchema = v.object({
  aggregatedOutput: v.nullable(v.string()),
  command: v.string(),
  cwd: v.string(),
  exitCode: v.nullable(v.number()),
  id: v.string(),
  status: v.picklist(['inProgress', 'completed', 'failed', 'declined']),
  type: v.literal('commandExecution')
}) satisfies v.GenericSchema<
  unknown,
  Pick<
    Extract<ThreadItem, { type: 'commandExecution' }>,
    'type' | 'id' | 'command' | 'cwd' | 'status' | 'aggregatedOutput' | 'exitCode'
  >
>
const FileItemSchema = v.object({
  changes: v.array(
    v.object({
      diff: v.string(),
      kind: v.variant('type', [
        v.object({ type: v.literal('add') }),
        v.object({ type: v.literal('delete') }),
        // biome-ignore lint/style/useNamingConvention: Codex protocol field name.
        v.object({ move_path: v.nullable(v.string()), type: v.literal('update') })
      ]),
      path: v.string()
    })
  ),
  id: v.string(),
  status: v.picklist(['inProgress', 'completed', 'failed', 'declined']),
  type: v.literal('fileChange')
}) satisfies v.GenericSchema<unknown, Extract<ThreadItem, { type: 'fileChange' }>>
const McpItemSchema = v.object({
  arguments: JsonSchema,
  error: v.nullable(v.object({ message: v.string() })),
  id: v.string(),
  result: v.nullable(
    v.object({ _meta: v.nullable(JsonSchema), content: v.array(JsonSchema), structuredContent: v.nullable(JsonSchema) })
  ),
  server: v.string(),
  status: v.picklist(['inProgress', 'completed', 'failed']),
  tool: v.string(),
  type: v.literal('mcpToolCall')
}) satisfies v.GenericSchema<
  unknown,
  Pick<
    Extract<ThreadItem, { type: 'mcpToolCall' }>,
    'type' | 'id' | 'server' | 'tool' | 'arguments' | 'status' | 'result' | 'error'
  >
>
export const ItemSchema = v.union([
  AgentMessageSchema,
  CommandItemSchema,
  FileItemSchema,
  McpItemSchema,
  v.object({
    id: v.string(),
    type: v.picklist([
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
export const ItemNotificationSchema = v.object({
  item: ItemSchema,
  threadId: v.string(),
  turnId: v.string()
}) satisfies v.GenericSchema<
  unknown,
  Pick<ItemStartedNotification & ItemCompletedNotification, 'threadId' | 'turnId'> & {
    item: Pick<ThreadItem, 'type' | 'id'>
  }
>
const AvailableDecisionsSchema = v.optional(
  v.nullable(
    v.array(
      v.union([v.picklist(['accept', 'acceptForSession', 'decline', 'cancel']), v.record(v.string(), JsonSchema)])
    )
  )
)
export const CommandApprovalSchema = v.object({
  availableDecisions: AvailableDecisionsSchema,
  command: v.optional(v.nullable(v.string())),
  cwd: v.optional(v.nullable(v.string())),
  itemId: v.string(),
  reason: v.optional(v.nullable(v.string())),
  threadId: v.string(),
  turnId: v.string()
}) satisfies v.GenericSchema<
  unknown,
  Pick<CommandExecutionRequestApprovalParams, 'threadId' | 'turnId' | 'itemId' | 'command' | 'cwd' | 'reason'>
>
export const FileApprovalSchema = v.object({
  availableDecisions: AvailableDecisionsSchema,
  grantRoot: v.optional(v.nullable(v.string())),
  itemId: v.string(),
  reason: v.optional(v.nullable(v.string())),
  threadId: v.string(),
  turnId: v.string()
}) satisfies v.GenericSchema<
  unknown,
  Pick<FileChangeRequestApprovalParams, 'threadId' | 'turnId' | 'itemId' | 'reason' | 'grantRoot'>
>
export const RequestResolvedSchema = v.object({ requestId: IdSchema, threadId: v.string() }) satisfies v.GenericSchema<
  unknown,
  ServerRequestResolvedNotification
>
const ErrorNotificationSchema = v.object({
  error: TurnErrorSchema,
  threadId: v.string(),
  turnId: v.string(),
  willRetry: v.boolean()
})

const parameterSchemas: Record<string, v.GenericSchema> = {
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
export const parseProtocol = <T extends v.GenericSchema>(schema: T, value: unknown): v.InferOutput<T> => {
  const result = v.safeParse(schema, value)
  if (!result.success) {
    throw new RuntimeError('PROTOCOL_ERROR', 'Invalid app-server protocol frame')
  }
  return result.output
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
      return parseProtocol(v.object({}), value)
    default:
      return value
  }
}

export const ElicitationApprovalSchema = v.object({
  message: v.string(),
  mode: v.picklist(['form', 'openai/form', 'openaiForm']),
  requestedSchema: v.object({
    properties: v.strictObject({}),
    required: v.optional(v.pipe(v.array(v.string()), v.maxLength(0))),
    type: v.literal('object')
  }),
  serverName: v.literal('project_resources'),
  threadId: v.string(),
  turnId: v.nullable(v.string())
}) satisfies v.GenericSchema<
  unknown,
  Pick<McpServerElicitationRequestParams, 'threadId' | 'turnId' | 'serverName' | 'mode' | 'message'>
>
export const ElicitationResponseSchema = v.strictObject({
  _meta: v.null(),
  action: v.picklist(['accept', 'decline']),
  content: v.nullable(v.strictObject({}))
}) satisfies v.GenericSchema<unknown, McpServerElicitationRequestResponse>
