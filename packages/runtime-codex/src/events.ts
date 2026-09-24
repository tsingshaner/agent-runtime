import { type AdapterNotice, type AdapterOutcome, parseEvent, RuntimeError } from '@qingshaner/runtime'

import type { output } from 'zod/mini'

import { DeltaSchema, ItemNotificationSchema, type ItemSchema, parseProtocol } from './protocol'

type Item = output<typeof ItemSchema>
/**
 * Wrap a validated AG-UI event in an adapter notice.
 */
const event = (value: unknown): AdapterNotice => {
  return { event: parseEvent(value), kind: 'event' }
}

/**
 * Project native item notifications into ordered AG-UI notices for one run.
 */
export class CodexEventMapper {
  finalReply?: string
  readonly #texts = new Map<string, { text: string; ended: boolean }>()
  readonly #tools = new Set<string>()
  readonly #completed = new Set<string>()

  readonly #sessionId: string
  readonly #runId: string

  constructor(sessionId: string, runId: string) {
    this.#sessionId = sessionId
    this.#runId = runId
  }

  /**
   * Validate and project supported notifications, suppressing repeated completed items.
   */
  accept(method: string, params: unknown): AdapterNotice[] {
    if (method === 'item/agentMessage/delta') {
      const { itemId, delta } = parseProtocol(DeltaSchema, params)
      const output: AdapterNotice[] = []
      const state = this.#text(itemId, output)
      if (!state.ended && delta) {
        state.text += delta
        output.push(event({ delta, messageId: this.#id(itemId), type: 'TEXT_MESSAGE_CONTENT' }))
      }
      return output
    }
    if (method === 'item/commandExecution/outputDelta' || method === 'item/fileChange/outputDelta') {
      const { itemId, delta } = parseProtocol(DeltaSchema, params)
      return [
        event({
          name: 'codex.progress',
          type: 'CUSTOM',
          value: { delta, itemId, method, runId: this.#runId, sessionId: this.#sessionId }
        })
      ]
    }
    if (method !== 'item/started' && method !== 'item/completed') {
      return []
    }
    const { item } = parseProtocol(ItemNotificationSchema, params)
    if (this.#completed.has(item.id)) {
      return []
    }
    const complete = method === 'item/completed'
    const output = this.#item(item, complete)
    if (complete) {
      this.#completed.add(item.id)
    }
    return output
  }

  /**
   * Close any open text messages before the run reaches its terminal outcome.
   */
  finish(_outcome: AdapterOutcome): AdapterNotice[] {
    const output: AdapterNotice[] = []
    for (const [itemId, state] of this.#texts) {
      if (!state.ended) {
        state.ended = true
        output.push(event({ messageId: this.#id(itemId), type: 'TEXT_MESSAGE_END' }))
      }
    }
    return output
  }

  #item(item: Item, complete: boolean): AdapterNotice[] {
    switch (item.type) {
      case 'agentMessage':
        return this.#message(item, complete)
      case 'mcpToolCall':
        return this.#tool(item, complete)
      case 'commandExecution':
      case 'fileChange':
        return [
          event({
            name: item.type === 'commandExecution' ? 'codex.command' : 'codex.file-change',
            type: 'CUSTOM',
            value: { item, runId: this.#runId, sessionId: this.#sessionId, stage: complete ? 'completed' : 'started' }
          })
        ]
      default:
        return []
    }
  }

  #message(item: Extract<Item, { type: 'agentMessage' }>, complete: boolean): AdapterNotice[] {
    const output: AdapterNotice[] = []
    const state = this.#text(item.id, output)
    if (!complete) {
      return output
    }
    if (!item.text.startsWith(state.text)) {
      throw new RuntimeError('PROJECTION_ERROR', 'Final message conflicts with streamed text')
    }
    const delta = item.text.slice(state.text.length)
    if (delta) {
      output.push(event({ delta, messageId: this.#id(item.id), type: 'TEXT_MESSAGE_CONTENT' }))
    }
    if (item.phase === 'final_answer') {
      this.finalReply = item.text
    }
    state.text = item.text
    state.ended = true
    output.push(event({ messageId: this.#id(item.id), type: 'TEXT_MESSAGE_END' }))
    return output
  }

  #tool(item: Extract<Item, { type: 'mcpToolCall' }>, complete: boolean): AdapterNotice[] {
    const output: AdapterNotice[] = []
    const itemId = this.#id(item.id)
    if (!this.#tools.has(item.id)) {
      this.#tools.add(item.id)
      output.push(
        event({ toolCallId: itemId, toolCallName: `${item.server}.${item.tool}`, type: 'TOOL_CALL_START' }),
        event({ delta: JSON.stringify(item.arguments), toolCallId: itemId, type: 'TOOL_CALL_ARGS' }),
        event({ toolCallId: itemId, type: 'TOOL_CALL_END' })
      )
    }
    if (complete) {
      output.push(
        event({
          content: JSON.stringify(item.error ? { error: item.error } : item.result),
          messageId: `${itemId}:result`,
          role: 'tool',
          toolCallId: itemId,
          type: 'TOOL_CALL_RESULT'
        })
      )
    }
    return output
  }

  #id(itemId: string): string {
    return `${this.#runId}:${itemId}`
  }

  #text(itemId: string, output: AdapterNotice[]) {
    let state = this.#texts.get(itemId)
    if (!state) {
      state = { ended: false, text: '' }
      this.#texts.set(itemId, state)
      output.push(event({ messageId: this.#id(itemId), role: 'assistant', type: 'TEXT_MESSAGE_START' }))
    }
    return state
  }
}
