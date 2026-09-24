import { randomUUID } from 'node:crypto'

import { EventType } from '@ag-ui/core'
import { AIMessage, type BaseMessage, ToolMessage } from '@langchain/core/messages'
import { RuntimeError } from '@qingshaner/runtime'

import type { AdapterNotice } from '@qingshaner/runtime'

export class Events {
  #current?: string
  readonly #calls = new Set<string>()
  readonly #results = new Set<string>()
  constructor(
    readonly runId: string,
    readonly emit: (notice: AdapterNotice) => Promise<void>,
    readonly past = new Set<string>()
  ) {}
  async end() {
    if (this.#current) {
      await this.emit({ event: { messageId: this.#current, type: EventType.TEXT_MESSAGE_END }, kind: 'event' })
      this.#current = undefined
    }
  }
  async message(message: BaseMessage) {
    if (!AIMessage.isInstance(message)) {
      return
    }
    const text =
      typeof message.content === 'string'
        ? message.content
        : message.content.map((p) => (p.type === 'text' ? p.text : '')).join('')
    if (!text) {
      return
    }
    const id = message.id ?? this.runId
    if (this.#current !== id) {
      await this.end()
      this.#current = id
      await this.emit({
        event: { messageId: id, role: 'assistant', type: EventType.TEXT_MESSAGE_START },
        kind: 'event'
      })
    }
    await this.emit({ event: { delta: text, messageId: id, type: EventType.TEXT_MESSAGE_CONTENT }, kind: 'event' })
  }
  async update(updates: Record<string, { messages?: BaseMessage[] }>) {
    for (const update of Object.values(updates)) {
      for (const message of update?.messages ?? []) {
        if (message.id && this.past.has(message.id)) {
          continue
        }
        await this.#tool(message)
      }
    }
  }
  async #tool(message: BaseMessage) {
    if (AIMessage.isInstance(message)) {
      for (const call of message.tool_calls ?? []) {
        if (!call.id) {
          throw new RuntimeError('PROTOCOL_ERROR', 'Native tool call lacks identity')
        }
        if (this.#calls.has(call.id)) {
          continue
        }
        this.#calls.add(call.id)
        await this.end()
        await this.emit({
          event: { toolCallId: call.id, toolCallName: call.name, type: EventType.TOOL_CALL_START },
          kind: 'event'
        })
        await this.emit({
          event: { delta: JSON.stringify(call.args), toolCallId: call.id, type: EventType.TOOL_CALL_ARGS },
          kind: 'event'
        })
        await this.emit({ event: { toolCallId: call.id, type: EventType.TOOL_CALL_END }, kind: 'event' })
      }
    }
    await this.#result(message)
  }
  async #result(message: BaseMessage) {
    if (ToolMessage.isInstance(message)) {
      if (this.#results.has(message.tool_call_id)) {
        return
      }
      this.#results.add(message.tool_call_id)
      await this.emit({
        event: {
          content: typeof message.content === 'string' ? message.content : JSON.stringify(message.content),
          messageId: message.id ?? randomUUID(),
          role: 'tool',
          toolCallId: message.tool_call_id,
          type: EventType.TOOL_CALL_RESULT
        },
        kind: 'event'
      })
    }
  }
}
