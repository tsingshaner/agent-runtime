import { randomUUID } from 'node:crypto'

import { EventType } from '@ag-ui/core'
import { RuntimeError } from '@qingshaner/runtime'

import type { AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { AdapterNotice, AdapterOutcome } from '@qingshaner/runtime'

export type Frame =
  | { kind: 'session'; event: SessionEvent }
  | { kind: 'stream'; frame: AssistantStreamFrame }
  | { kind: 'idle' }
export async function* readFrames(body: ReadableStream<Uint8Array>): AsyncGenerator<Frame> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      buffer += decoder.decode(value, { stream: true })
      if (buffer.length > 1048576) {
        throw new RuntimeError('DSH_PROTOCOL_ERROR', 'DSH frame exceeded limit')
      }
      while (buffer.includes('\n')) {
        const boundary = buffer.indexOf('\n')
        yield JSON.parse(buffer.slice(0, boundary)) as Frame
        buffer = buffer.slice(boundary + 1)
      }
    }
    if (buffer.trim()) {
      throw new RuntimeError('DSH_PROTOCOL_ERROR', 'Incomplete DSH frame')
    }
  } finally {
    await reader.cancel()
  }
}
export class Projection {
  outcome?: AdapterOutcome
  finalReply = ''
  idle = false
  #messageId = ''
  #opened = false
  constructor(
    readonly runId: string,
    readonly emit: (notice: AdapterNotice) => Promise<void>
  ) {}
  accept = async (frame: Frame) => {
    switch (frame.kind) {
      case 'idle':
        this.idle = true
        return
      case 'session':
        await this.#session(frame.event)
        return
      case 'stream':
        await this.#stream(frame.frame)
        return
      default:
        throw new RuntimeError('DSH_PROTOCOL_ERROR', 'Unknown control frame')
    }
  }
  #stream = async (frame: AssistantStreamFrame) => {
    if (frame.type === 'start') {
      this.#messageId = `${this.runId}:${frame.revision}`
      this.#opened = false
      return
    }
    if (frame.type === 'end' && this.#opened) {
      await this.emit({ event: { messageId: this.#messageId, type: EventType.TEXT_MESSAGE_END }, kind: 'event' })
      this.#opened = false
      return
    }
    if (frame.type !== 'chunk' || frame.chunk.type !== 'text-delta' || !frame.chunk.text) {
      return
    }
    if (!this.#opened) {
      await this.emit({
        event: { messageId: this.#messageId, role: 'assistant', type: EventType.TEXT_MESSAGE_START },
        kind: 'event'
      })
      this.#opened = true
    }
    await this.emit({
      event: { delta: frame.chunk.text, messageId: this.#messageId, type: EventType.TEXT_MESSAGE_CONTENT },
      kind: 'event'
    })
  }
  #session = async (event: SessionEvent) => {
    switch (event.type) {
      case 'turn/start':
        await this.emit({ kind: 'started', nativeTurnId: String(event.data.turn) })
        return
      case 'assistant/message':
        this.finalReply = event.data.message.content
          .filter((block) => block.type === 'text')
          .map((block) => block.text)
          .join('')
        return
      case 'tool/call':
        await this.emit({
          event: { toolCallId: event.data.callId, toolCallName: event.data.name, type: EventType.TOOL_CALL_START },
          kind: 'event'
        })
        await this.emit({
          event: { delta: event.data.arguments, toolCallId: event.data.callId, type: EventType.TOOL_CALL_ARGS },
          kind: 'event'
        })
        await this.emit({ event: { toolCallId: event.data.callId, type: EventType.TOOL_CALL_END }, kind: 'event' })
        return
      case 'tool/result':
        for (const block of event.data.message.content) {
          if (block.type === 'tool-result') {
            await this.emit({
              event: {
                content: JSON.stringify(block.content),
                messageId: randomUUID(),
                role: 'tool',
                toolCallId: block.toolCallId,
                type: EventType.TOOL_CALL_RESULT
              },
              kind: 'event'
            })
          }
        }
        return
      case 'turn/end':
        this.outcome =
          event.data.reason.kind === 'completed'
            ? { status: 'succeeded' }
            : event.data.reason.kind === 'aborted'
              ? { status: 'cancelled' }
              : {
                  error: { code: 'DSH_TURN_FAILED', message: `DSH turn ended: ${event.data.reason.kind}` },
                  status: 'failed'
                }
    }
  }
}
