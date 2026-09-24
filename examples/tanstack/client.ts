import { createORPCClient, getEventMeta, ORPCError } from '@orpc/client'
import { OpenAPILink } from '@orpc/openapi/fetch'
import { contract, type RuntimeContractClient } from '@qingshaner/runtime-contract'
import { StreamProcessor } from '@tanstack/ai-client'

import type { Approval, ApprovalDecision, InputAnswers, InputRequest } from '@qingshaner/runtime'
import type { StreamProcessorOptions } from '@tanstack/ai-client'

type Chunk = Parameters<StreamProcessor['processChunk']>[0]
interface Handlers {
  signal?: AbortSignal
  events?: StreamProcessorOptions['events']
  onEvent?: (event: Chunk) => void
  approval?: (request: Omit<Approval, 'nativeRequestId'>, signal: AbortSignal) => Promise<ApprovalDecision>
  input?: (request: Omit<InputRequest, 'nativeRequestId'>, signal: AbortSignal) => Promise<InputAnswers>
}

/** Submissions are never retried; only event subscriptions resume from their durable cursor. */
export class RuntimeClient {
  readonly api: RuntimeContractClient

  constructor(url: string, token: string, fetchClient: typeof fetch = fetch) {
    this.api = createORPCClient(
      new OpenAPILink(contract, {
        fetch: fetchClient,
        headers: { authorization: `Bearer ${token}` },
        origin: url
      })
    )
  }

  submit = (sessionId: string, text: string, requestId = crypto.randomUUID()) =>
    this.api.sessions.run({ body: { requestId, text }, params: { id: sessionId } })

  cancel = (runId: string) => this.api.runs.cancel({ params: { id: runId } })

  watch = async (
    runId: string,
    handlers: Handlers = {}
  ): Promise<{ messages: ReturnType<StreamProcessor['getMessages']>; terminal: Chunk }> => {
    const processor = new StreamProcessor({ events: handlers.events })
    const stop = new AbortController()
    const signal = handlers.signal ? AbortSignal.any([stop.signal, handlers.signal]) : stop.signal
    let interaction = Promise.resolve()
    let failure: unknown
    let terminal: Chunk | undefined
    try {
      for await (const event of this.#subscribe(runId, signal)) {
        // Both packages use AG-UI wire events but currently ship distinct enum versions.
        const chunk = event as unknown as Chunk
        if (terminal) {
          throw new Error('Event after terminal')
        }
        processor.processChunk(chunk)
        handlers.onEvent?.(chunk)
        if (chunk.type === 'RUN_FINISHED' || chunk.type === 'RUN_ERROR') {
          terminal = chunk
        }
        if (chunk.type === 'CUSTOM') {
          interaction = interaction
            .then(() => this.#interact(runId, chunk, handlers, signal))
            .catch((error: unknown) => {
              if (!signal.aborted) {
                failure = error
                stop.abort()
              }
            })
        }
      }
      signal.throwIfAborted()
      if (!terminal) {
        throw new Error(
          handlers.signal?.aborted ? 'Subscription aborted; Run remains active' : 'Missing terminal event'
        )
      }
      return { messages: processor.getMessages(), terminal }
    } catch (error) {
      throw failure ?? error
    } finally {
      stop.abort()
    }
  }

  async *#subscribe(runId: string, signal: AbortSignal) {
    let lastEventId: string | undefined
    let terminal = false
    for (let attempt = 0; ; attempt++) {
      try {
        for await (const event of await this.api.runs.events(
          { params: { id: runId }, query: {} },
          { lastEventId, signal }
        )) {
          lastEventId = getEventMeta(event)?.id ?? lastEventId
          terminal = event.type === 'RUN_FINISHED' || event.type === 'RUN_ERROR'
          yield event
        }
        if (terminal) {
          return
        }
      } catch (error) {
        if (signal.aborted || error instanceof ORPCError || terminal || attempt >= 5) {
          throw error
        }
      }
      if (attempt >= 5) {
        throw new Error('Missing terminal event after reconnect attempts')
      }
      await new Promise((resolve) => setTimeout(resolve, 250))
      signal.throwIfAborted()
    }
  }

  #interact = async (runId: string, chunk: Chunk, handlers: Handlers, signal: AbortSignal) => {
    signal.throwIfAborted()
    if (chunk.type !== 'CUSTOM') {
      return
    }
    // Read typed persisted requests; custom events are notifications, not a second protocol.
    if (chunk.name === 'runtime.approval.requested' && handlers.approval) {
      const requests = await this.api.runs.approvals({ params: { id: runId } }, { signal })
      for (const request of requests.filter((item) => item.status === 'pending')) {
        signal.throwIfAborted()
        const decision = await handlers.approval(request, signal)
        signal.throwIfAborted()
        await this.api.runs.approve({ body: { decision }, params: { id: runId, item: request.id } }, { signal })
      }
    }
    if (chunk.name === 'runtime.input.requested' && handlers.input) {
      const requests = await this.api.runs.inputs({ params: { id: runId } }, { signal })
      for (const request of requests.filter((item) => item.status === 'pending')) {
        signal.throwIfAborted()
        const answers = await handlers.input(request, signal)
        signal.throwIfAborted()
        await this.api.runs.answer({ body: { answers }, params: { id: runId, item: request.id } }, { signal })
      }
    }
  }
}
