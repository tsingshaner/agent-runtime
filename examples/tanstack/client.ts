import { fetchServerSentEvents, StreamProcessor } from '@tanstack/ai-client'

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

/** One POST creates a Run; official joinRun handles GET-only reconnection. */
export class RuntimeClient {
  readonly url: string
  private readonly token: string
  private readonly fetchClient: typeof fetch

  constructor(url: string, token: string, fetchClient: typeof fetch = fetch) {
    this.url = url
    this.token = token
    this.fetchClient = fetchClient
  }

  request = async <T>(path: string, body?: unknown): Promise<T> => {
    const response = await this.fetchClient(this.url + path, {
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      method: body === undefined ? 'GET' : 'POST',
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    })
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`)
    }
    return response.json() as Promise<T>
  }

  submit = (sessionId: string, text: string, requestId = crypto.randomUUID()) =>
    this.request<{ runId: string }>(`/sessions/${encodeURIComponent(sessionId)}/runs`, { requestId, text })

  cancel = (runId: string) => this.request(`/runs/${encodeURIComponent(runId)}/cancel`, {})

  watch = async (
    runId: string,
    handlers: Handlers = {}
  ): Promise<{ messages: ReturnType<StreamProcessor['getMessages']>; terminal: Chunk }> => {
    const path = `/runs/${encodeURIComponent(runId)}`
    const connection = fetchServerSentEvents(`${this.url + path}/events`, {
      fetchClient: this.fetchClient,
      headers: { authorization: `Bearer ${this.token}` },
      reconnect: { delayMs: 250, maxAttempts: 5 }
    })
    const processor = new StreamProcessor({ events: handlers.events })
    const stop = new AbortController()
    const signal = handlers.signal ? AbortSignal.any([stop.signal, handlers.signal]) : stop.signal
    let interaction = Promise.resolve()
    let failure: unknown
    let terminal: Chunk | undefined
    try {
      for await (const chunk of connection.joinRun(runId, signal)) {
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
            .then(() => this.interact(path, chunk, handlers, signal))
            .catch((error: unknown) => {
              if (!signal.aborted) {
                failure = error
                stop.abort()
              }
            })
        }
      }
      if (failure) {
        throw failure
      }
      if (!terminal) {
        throw new Error(
          handlers.signal?.aborted ? 'Subscription aborted; Run remains active' : 'Missing terminal event'
        )
      }
      return { messages: processor.getMessages(), terminal }
    } finally {
      stop.abort()
    }
  }

  private interact = async (path: string, chunk: Chunk, handlers: Handlers, signal: AbortSignal) => {
    signal.throwIfAborted()
    if (chunk.type !== 'CUSTOM') {
      return
    }
    // Read typed persisted requests; custom events are notifications, not a second protocol.
    if (chunk.name === 'runtime.approval.requested' && handlers.approval) {
      const requests = await this.request<Approval[]>(`${path}/approvals`)
      for (const request of requests.filter((item) => item.status === 'pending')) {
        signal.throwIfAborted()
        const decision = await handlers.approval(request, signal)
        signal.throwIfAborted()
        await this.request(`${path}/approvals/${encodeURIComponent(request.id)}`, { decision })
      }
    }
    if (chunk.name === 'runtime.input.requested' && handlers.input) {
      const requests = await this.request<InputRequest[]>(`${path}/inputs`)
      for (const request of requests.filter((item) => item.status === 'pending')) {
        signal.throwIfAborted()
        const answers = await handlers.input(request, signal)
        signal.throwIfAborted()
        await this.request(`${path}/inputs/${encodeURIComponent(request.id)}`, { answers })
      }
    }
  }
}
