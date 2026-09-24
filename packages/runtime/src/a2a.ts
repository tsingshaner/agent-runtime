import { AgentCard, type Message, StreamResponse, Task, TaskState } from '@a2a-js/sdk'
import {
  A2AError,
  PushNotificationNotSupportedError,
  RequestMalformedError,
  TaskNotCancelableError,
  TaskNotFoundError,
  UnsupportedOperationError
} from '@a2a-js/sdk/errors'
import { type A2ARequestHandler, JsonRpcTransportHandler, ServerCallContext, validateVersion } from '@a2a-js/sdk/server'
import { EventType } from '@ag-ui/core'
import * as z from 'zod/mini'

import { RuntimeError } from './errors'

import type { RuntimeManager } from './manager'
import type { AgUiEvent, RunStatus } from './types'

type Snapshot = Awaited<ReturnType<RuntimeManager['getTask']>>
const states: Record<RunStatus, TaskState> = {
  cancelled: TaskState.TASK_STATE_CANCELED,
  cancelling: TaskState.TASK_STATE_WORKING,
  failed: TaskState.TASK_STATE_FAILED,
  interrupted: TaskState.TASK_STATE_FAILED,
  running: TaskState.TASK_STATE_WORKING,
  starting: TaskState.TASK_STATE_SUBMITTED,
  succeeded: TaskState.TASK_STATE_COMPLETED,
  // biome-ignore lint/style/useNamingConvention: Persisted Run status.
  waiting_approval: TaskState.TASK_STATE_INPUT_REQUIRED,
  // biome-ignore lint/style/useNamingConvention: Persisted Run status.
  waiting_input: TaskState.TASK_STATE_INPUT_REQUIRED
}
const toTask = (snapshot: Snapshot): Task =>
  Task.fromJSON({
    artifacts: Object.entries(snapshot.texts).map(([artifactId, text]) => ({ artifactId, parts: [{ text }] })),
    contextId: snapshot.run.sessionId,
    id: snapshot.id,
    metadata: { runId: snapshot.run.id, runStatus: snapshot.run.status },
    status: {
      state: states[snapshot.run.status],
      ...((snapshot.inputs.length || snapshot.approvals.length) && !terminal(snapshot)
        ? {
            message: {
              contextId: snapshot.run.sessionId,
              messageId: `${snapshot.id}:${snapshot.run.lastSequence}`,
              parts: [
                {
                  data: {
                    approvals: snapshot.approvals.map(({ nativeRequestId: _native, ...approval }) => approval),
                    inputs: snapshot.inputs.map(({ nativeRequestId: _native, answers: _answers, ...input }) => input)
                  }
                }
              ],
              role: 'ROLE_AGENT',
              taskId: snapshot.id
            }
          }
        : {})
    }
  })
const terminal = (snapshot: Snapshot) =>
  ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(snapshot.run.status)
const safe = (error: unknown) => (error instanceof A2AError ? error : new Error('Runtime operation failed'))
const unsupported = (): never => {
  throw new UnsupportedOperationError()
}

const nonempty = z.string().check(z.minLength(1))
const historyLength = z.optional(z.int().check(z.minimum(0)))
const messageSchema = z.object({
  contextId: z.optional(z.string()),
  extensions: z.optional(z.array(z.string())),
  messageId: nonempty,
  parts: z
    .array(
      z.union([
        z.object({
          data: z.optional(z.never()),
          raw: z.optional(z.never()),
          text: nonempty,
          url: z.optional(z.never())
        }),
        z.object({
          data: z.record(z.string(), z.unknown()),
          raw: z.optional(z.never()),
          text: z.optional(z.never()),
          url: z.optional(z.never())
        })
      ])
    )
    .check(z.minLength(1)),
  referenceTaskIds: z.optional(z.array(z.string())),
  role: z.union([z.literal('ROLE_USER'), z.literal(1)]),
  taskId: z.optional(z.string())
})
const sendSchema = z.object({
  configuration: z.optional(
    z.object({
      acceptedOutputModes: z.optional(z.array(z.string())),
      historyLength,
      returnImmediately: z.optional(z.boolean()),
      taskPushNotificationConfig: z.optional(z.unknown())
    })
  ),
  message: messageSchema,
  tenant: z.optional(z.string())
})
const querySchema = z.object({ historyLength, id: nonempty, tenant: z.optional(z.string()) })
const envelopeSchema = z.object({
  id: z.union([z.string(), z.int(), z.null()]),
  jsonrpc: z.literal('2.0'),
  method: nonempty,
  params: z.optional(z.record(z.string(), z.unknown()))
})

// Read with a bound before JSON parsing; Content-Length alone is not trustworthy.
const readBody = async (request: Request) => {
  const reader = request.body?.getReader()
  if (!reader) {
    throw new RequestMalformedError()
  }
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) {
        break
      }
      size += chunk.value.byteLength
      if (size > 1024 * 1024) {
        await reader.cancel()
        throw new RequestMalformedError('Request too large')
      }
      chunks.push(chunk.value)
    }
  } finally {
    reader.releaseLock()
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString()) as unknown
  } catch {
    throw new RequestMalformedError()
  }
}

const validateRequest = (body: z.infer<typeof envelopeSchema>, request: Request, card: AgentCard) => {
  validateVersion(request.headers.get('a2a-version') ?? '0.3', card, 'JSONRPC')
  if (body.method === 'SendMessage' || body.method === 'SendStreamingMessage') {
    z.parse(sendSchema, body.params)
  }
  if (['GetTask', 'CancelTask', 'SubscribeToTask'].includes(body.method)) {
    z.parse(querySchema, body.params)
  }
  if (body.params?.tenant) {
    throw new UnsupportedOperationError()
  }
}

const rpcResponse = (
  result: Awaited<ReturnType<JsonRpcTransportHandler['handle']>>,
  id: string | number | null,
  stopped: AbortController
): Response => {
  if (!(Symbol.asyncIterator in result)) {
    if ('error' in result && result.error) {
      const error = result.error as { code: number; message: string }
      if (error.code === -32603) {
        error.message = 'Runtime operation failed'
      }
    }
    return Response.json(result)
  }
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    async cancel() {
      stopped.abort()
      await result.return()
    },
    async pull(controller) {
      try {
        const next = await result.next()
        if (stopped.signal.aborted) {
          return
        }
        if (next.done) {
          controller.close()
        } else {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(next.value)}\n\n`))
        }
      } catch (error) {
        if (stopped.signal.aborted) {
          return
        }
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({ error: JsonRpcTransportHandler.mapToJSONRPCError(safe(error)), id, jsonrpc: '2.0' })}\n\n`
          )
        )
        controller.close()
      }
    }
  })
  return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
}

/** A2A 1.0 Fetch routes. The host must authorize requests before calling this handler. */
export const createA2AHandler = (manager: RuntimeManager, origin: string, shutdown?: AbortSignal) => {
  const card = AgentCard.fromJSON({
    capabilities: { streaming: true },
    defaultInputModes: ['text/plain', 'application/json'],
    defaultOutputModes: ['text/plain', 'application/json'],
    description: 'Run work in an existing managed session. Set message.contextId to the session ID.',
    name: 'Agent Runtime',
    securityRequirements: [{ schemes: { bearerAuth: { list: [] } } }],
    securitySchemes: { bearerAuth: { httpAuthSecurityScheme: { scheme: 'bearer' } } },
    skills: [
      {
        description: 'Execute and interact with a managed runtime.',
        id: 'runtime',
        name: 'Managed execution',
        tags: ['runtime']
      }
    ],
    supportedInterfaces: [{ protocolBinding: 'JSONRPC', protocolVersion: '1.0', url: `${origin}/a2a` }],
    version: '1.0.0'
  })
  const read = async (id: string) => {
    try {
      return await manager.getTask(id)
    } catch (error) {
      if (error instanceof RuntimeError && error.code === 'TASK_NOT_FOUND') {
        throw new TaskNotFoundError()
      }
      throw error
    }
  }
  const projectEvent = async (snapshot: Snapshot, event: AgUiEvent, knownArtifacts: Set<string>) => {
    if (event.type === EventType.TEXT_MESSAGE_CONTENT || event.type === EventType.TEXT_MESSAGE_END) {
      const append = knownArtifacts.has(event.messageId)
      knownArtifacts.add(event.messageId)
      return StreamResponse.fromJSON({
        artifactUpdate: {
          append,
          artifact: {
            artifactId: event.messageId,
            parts: [{ text: event.type === EventType.TEXT_MESSAGE_CONTENT ? event.delta : '' }]
          },
          contextId: snapshot.run.sessionId,
          lastChunk: event.type === EventType.TEXT_MESSAGE_END,
          taskId: snapshot.id
        }
      })
    }
    const ended = event.type === EventType.RUN_FINISHED || event.type === EventType.RUN_ERROR
    if (event.type !== EventType.CUSTOM && !ended) {
      return undefined
    }
    const current = await read(snapshot.id)
    // Deliver output before announcing the terminal event that follows it.
    if (terminal(current) && !ended) {
      return undefined
    }
    return {
      payload: {
        $case: 'statusUpdate' as const,
        value: {
          contextId: snapshot.run.sessionId,
          metadata: undefined,
          status: toTask(current).status,
          taskId: snapshot.id
        }
      }
    }
  }
  const watch = async function* (snapshot: Snapshot, context: ServerCallContext): AsyncGenerator<StreamResponse> {
    yield { payload: { $case: 'task', value: toTask(snapshot) } }
    if (terminal(snapshot)) {
      return
    }
    const knownArtifacts = new Set(Object.keys(snapshot.texts))
    const signal = context.state.get('signal') as AbortSignal
    for await (const { event } of manager.subscribe(snapshot.run.id, {
      afterSequence: snapshot.run.lastSequence,
      signal
    })) {
      const update = await projectEvent(snapshot, event, knownArtifacts)
      if (update) {
        yield update
      }
      if (event.type === EventType.RUN_FINISHED || event.type === EventType.RUN_ERROR) {
        return
      }
    }
  }
  const respond = async (message: Message) => {
    const snapshot = await read(message.taskId)
    if (terminal(snapshot)) {
      return unsupported()
    }
    if (message.contextId && message.contextId !== snapshot.run.sessionId) {
      throw new RequestMalformedError()
    }
    if (message.parts.length !== 1 || message.parts[0]?.content?.$case !== 'data') {
      throw new RequestMalformedError('Reply with one interaction data part')
    }
    const response = z.safeParse(
      z.union([
        z.strictObject({ answers: z.record(z.string(), z.array(z.string())), inputId: z.string() }),
        z.strictObject({ approvalId: z.string(), decision: z.enum(['approve', 'deny']) })
      ]),
      message.parts[0].content.value
    )
    if (!response.success) {
      throw new RequestMalformedError()
    }
    if ('inputId' in response.data) {
      await manager.respondInput(snapshot.run.id, response.data.inputId, response.data.answers)
    } else {
      await manager.respondApproval(snapshot.run.id, response.data.approvalId, response.data.decision)
    }
    return read(snapshot.id)
  }
  const submit = (params: Parameters<A2ARequestHandler['sendMessage']>[0]) => {
    const { message } = params
    if (message?.role !== 1) {
      throw new RequestMalformedError()
    }
    if (params.configuration?.taskPushNotificationConfig) {
      throw new PushNotificationNotSupportedError()
    }
    if (params.tenant || message.extensions.length > 0 || message.referenceTaskIds.length > 0) {
      return unsupported()
    }
    if (message.taskId) {
      return respond(message)
    }
    if (!message.contextId || message.parts.some((part) => part.content?.$case !== 'text')) {
      return unsupported()
    }
    return manager.startTask(message.contextId, {
      requestId: `a2a:${message.messageId}`,
      text: message.parts.map((part) => part.content?.value).join('\n')
    })
  }
  const handler: A2ARequestHandler = {
    cancelTask: async ({ id }) => {
      const snapshot = await read(id)
      if (terminal(snapshot)) {
        throw new TaskNotCancelableError()
      }
      await manager.cancel(snapshot.run.id)
      return toTask(await read(id))
    },
    createTaskPushNotificationConfig: unsupported,
    deleteTaskPushNotificationConfig: unsupported,
    getAgentCard: async () => card,
    getAuthenticatedExtendedAgentCard: unsupported,
    getTask: async ({ id }) => toTask(await read(id)),
    getTaskPushNotificationConfig: unsupported,
    listTaskPushNotificationConfigs: unsupported,
    listTasks: unsupported,
    resubscribe: async function* ({ id }, context) {
      const snapshot = await read(id)
      if (terminal(snapshot)) {
        return unsupported()
      }
      yield* watch(snapshot, context)
    },
    sendMessage: async (params, context) => {
      const snapshot = await submit(params)
      if (
        params.configuration?.returnImmediately ||
        terminal(snapshot) ||
        states[snapshot.run.status] === TaskState.TASK_STATE_INPUT_REQUIRED
      ) {
        return toTask(snapshot)
      }
      for await (const event of watch(snapshot, context)) {
        if (event.payload?.$case === 'statusUpdate') {
          const state = event.payload.value.status?.state
          if (state !== TaskState.TASK_STATE_SUBMITTED && state !== TaskState.TASK_STATE_WORKING) {
            break
          }
        }
      }
      return toTask(await read(snapshot.id))
    },
    sendMessageStream: async function* (params, context) {
      yield* watch(await submit(params), context)
    }
  }
  const transport = new JsonRpcTransportHandler(handler)
  return async (request: Request): Promise<Response | undefined> => {
    const path = new URL(request.url).pathname
    if (path === '/.well-known/agent-card.json' && request.method === 'GET') {
      return Response.json(AgentCard.toJSON(card))
    }
    if (path !== '/a2a') {
      return undefined
    }
    if (request.method !== 'POST') {
      return new Response(null, { status: 405 })
    }
    const stopped = new AbortController()
    const signal = AbortSignal.any([request.signal, stopped.signal, ...(shutdown ? [shutdown] : [])])
    const context = new ServerCallContext({ requestedVersion: '1.0', state: new Map([['signal', signal]]) })
    let body: z.infer<typeof envelopeSchema> | undefined
    try {
      body = z.parse(envelopeSchema, await readBody(request))
      validateRequest(body, request, card)
    } catch (error) {
      return Response.json({
        error: JsonRpcTransportHandler.mapToJSONRPCError(
          error instanceof A2AError ? error : new RequestMalformedError()
        ),
        id: body?.id ?? null,
        jsonrpc: '2.0'
      })
    }
    const result = await transport.handle(body, context)
    return rpcResponse(result, body.id, stopped)
  }
}
