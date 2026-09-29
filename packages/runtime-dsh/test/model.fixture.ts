// biome-ignore-all lint/style/useNamingConvention: DeepSeek Messages wire fields.
export type ModelReply = string | { name: string; arguments: Record<string, unknown> }

/** Deterministic DeepSeek Messages SSE for real Harness integration checks. */
export const modelReply = (answer: ModelReply, id: string) => {
  const text = typeof answer === 'string'
  return [
    {
      message: {
        content: [],
        id,
        model: 'deepseek-v4-flash',
        role: 'assistant',
        type: 'message',
        usage: { input_tokens: 10, output_tokens: 0 }
      },
      type: 'message_start'
    },
    {
      content_block: text ? { text: '', type: 'text' } : { id, input: {}, name: answer.name, type: 'tool_use' },
      index: 0,
      type: 'content_block_start'
    },
    {
      delta: text
        ? { text: answer, type: 'text_delta' }
        : { partial_json: JSON.stringify(answer.arguments), type: 'input_json_delta' },
      index: 0,
      type: 'content_block_delta'
    },
    { index: 0, type: 'content_block_stop' },
    {
      delta: { stop_reason: text ? 'end_turn' : 'tool_use', stop_sequence: null },
      type: 'message_delta',
      usage: { output_tokens: 2 }
    },
    { type: 'message_stop' }
  ]
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join('')
}
