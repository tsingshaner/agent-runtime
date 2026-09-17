import { type AdapterNotice, parseEvent } from '@qingshaner/runtime'
import { describe, expect, test } from 'vitest'

import { CodexEventMapper } from './events'

const address = { threadId: 'native', turnId: 'turn' }
const message = (text: string) => ({ ...address, item: { id: 'm1', phase: null, text, type: 'agentMessage' } })
const events = (notices: AdapterNotice[]) => notices.flatMap((n) => (n.kind === 'event' ? [parseEvent(n.event)] : []))

describe('CodexEventMapper', () => {
  test('emits only the missing suffix and ignores duplicate completions', () => {
    const mapper = new CodexEventMapper('s1', 'r1')
    const output = events([
      ...mapper.accept('item/started', message('')),
      ...mapper.accept('item/agentMessage/delta', { ...address, delta: 'hello', itemId: 'm1' }),
      ...mapper.accept('item/completed', message('hello world')),
      ...mapper.accept('item/completed', message('hello world')),
      ...mapper.finish({ status: 'succeeded' })
    ])
    expect(output.map((e) => e.type)).toEqual([
      'TEXT_MESSAGE_START',
      'TEXT_MESSAGE_CONTENT',
      'TEXT_MESSAGE_CONTENT',
      'TEXT_MESSAGE_END'
    ])
    expect(output.filter((e) => e.type === 'TEXT_MESSAGE_CONTENT').map((e) => e.delta)).toEqual(['hello', ' world'])
  })

  test('projects a completion without deltas once', () => {
    const mapper = new CodexEventMapper('s1', 'r1')
    expect(events(mapper.accept('item/completed', message('hello')))).toEqual([
      { messageId: 'r1:m1', role: 'assistant', type: 'TEXT_MESSAGE_START' },
      { delta: 'hello', messageId: 'r1:m1', type: 'TEXT_MESSAGE_CONTENT' },
      { messageId: 'r1:m1', type: 'TEXT_MESSAGE_END' }
    ])
  })

  test('rejects a final text that conflicts with streamed content', () => {
    const mapper = new CodexEventMapper('s1', 'r1')
    mapper.accept('item/agentMessage/delta', { ...address, delta: 'hello', itemId: 'm1' })
    expect(() => mapper.accept('item/completed', message('goodbye'))).toThrow(
      expect.objectContaining({ code: 'PROJECTION_ERROR' })
    )
  })

  test('closes partial text on failure without manufacturing a tool result', () => {
    const mapper = new CodexEventMapper('s1', 'r1')
    mapper.accept('item/agentMessage/delta', { ...address, delta: 'partial', itemId: 'm1' })
    mapper.accept('item/started', {
      ...address,
      item: {
        arguments: { q: 'hi' },
        error: null,
        id: 'tool',
        result: null,
        server: 'mcp',
        status: 'inProgress',
        tool: 'search',
        type: 'mcpToolCall'
      }
    })
    expect(events(mapper.finish({ status: 'failed' }))).toEqual([{ messageId: 'r1:m1', type: 'TEXT_MESSAGE_END' }])
  })

  test('emits known MCP arguments before the actual result', () => {
    const mapper = new CodexEventMapper('s1', 'r1')
    const item = {
      arguments: { q: 'hi' },
      error: null,
      id: 'tool',
      result: null,
      server: 'mcp',
      status: 'inProgress',
      tool: 'search',
      type: 'mcpToolCall'
    }
    const start = events(mapper.accept('item/started', { ...address, item }))
    expect(start).toEqual([
      { toolCallId: 'r1:tool', toolCallName: 'mcp.search', type: 'TOOL_CALL_START' },
      { delta: '{"q":"hi"}', toolCallId: 'r1:tool', type: 'TOOL_CALL_ARGS' },
      { toolCallId: 'r1:tool', type: 'TOOL_CALL_END' }
    ])
    const done = {
      ...address,
      item: {
        ...item,
        result: { _meta: null, content: [{ text: 'found' }], structuredContent: null },
        status: 'completed'
      }
    }
    expect(events(mapper.accept('item/completed', done))).toEqual([
      {
        content: JSON.stringify(done.item.result),
        messageId: 'r1:tool:result',
        role: 'tool',
        toolCallId: 'r1:tool',
        type: 'TOOL_CALL_RESULT'
      }
    ])
    expect(mapper.accept('item/completed', done)).toEqual([])
  })

  test.each([
    [
      'commandExecution',
      'codex.command',
      { aggregatedOutput: 'a', command: 'ls', cwd: '/tmp', exitCode: 0, status: 'completed' }
    ],
    [
      'fileChange',
      'codex.file-change',
      { changes: [{ diff: '+a', kind: { type: 'add' }, path: '/a' }], status: 'completed' }
    ]
  ])('preserves truthful %s data in custom events', (type, name, detail) => {
    const mapper = new CodexEventMapper('s1', 'r1')
    const output = events(mapper.accept('item/completed', { ...address, item: { id: 'item', type, ...detail } }))
    expect(output).toEqual([
      {
        name,
        type: 'CUSTOM',
        value: { item: { id: 'item', type, ...detail }, runId: 'r1', sessionId: 's1', stage: 'completed' }
      }
    ])
  })

  test('projects output progress and ignores unknown notifications', () => {
    const mapper = new CodexEventMapper('s1', 'r1')
    expect(
      events(mapper.accept('item/commandExecution/outputDelta', { ...address, delta: 'working', itemId: 'tool' }))
    ).toEqual([
      {
        name: 'codex.progress',
        type: 'CUSTOM',
        value: {
          delta: 'working',
          itemId: 'tool',
          method: 'item/commandExecution/outputDelta',
          runId: 'r1',
          sessionId: 's1'
        }
      }
    ])
    expect(mapper.accept('future/notification', { ...address })).toEqual([])
  })
})

test('exposes only completed final answers for memory', () => {
  const mapper = new CodexEventMapper('s', 'r')
  mapper.accept('item/completed', {
    ...address,
    item: { id: 'comment', phase: 'commentary', text: 'working', type: 'agentMessage' }
  })
  expect(mapper.finalReply).toBeUndefined()
  mapper.accept('item/completed', {
    ...address,
    item: { id: 'answer', phase: 'final_answer', text: 'answer', type: 'agentMessage' }
  })
  expect(mapper.finalReply).toBe('answer')
})
