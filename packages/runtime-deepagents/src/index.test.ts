// cspell:ignore langgraph checkpointer
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout } from 'node:timers/promises'

import { BaseChatModel } from '@langchain/core/language_models/chat_models'
import { AIMessage, AIMessageChunk, type BaseMessage } from '@langchain/core/messages'
import { ChatGenerationChunk } from '@langchain/core/outputs'
import { RuntimeManager } from '@qingshaner/runtime'
import { describe, expect, test } from 'vitest'
import { z } from 'zod'

import type { CallbackManagerForLLMRun } from '@langchain/core/callbacks/manager'

import { DeepAgentsRuntime } from './index'

class Model extends BaseChatModel {
  _llmType() {
    return 'fixture'
  }
  bindTools() {
    return this
  }
  _generate(messages: BaseMessage[]) {
    const last = messages.at(-1)
    const message =
      last?.content === 'slow'
        ? new AIMessage({ content: '', tool_calls: [{ args: {}, id: 'slow', name: 'slow_effect', type: 'tool_call' }] })
        : last?.content === 'input'
          ? new AIMessage({
              content: '',
              tool_calls: [
                {
                  args: { questions: [{ header: 'Name', id: 'name', question: 'Your name?' }] },
                  id: 'ask',
                  name: 'ask_user',
                  type: 'tool_call'
                }
              ]
            })
          : last?.content === 'batch'
            ? new AIMessage({
                content: '',
                tool_calls: ['approved', 'denied'].map((label) => ({
                  args: { label },
                  id: label,
                  name: 'record_effect',
                  type: 'tool_call' as const
                }))
              })
            : new AIMessage(`Reply ${messages.filter((m) => m.type === 'human').length}`)
    return Promise.resolve({ generations: [{ message, text: String(message.content) }] })
  }
}

class StreamingModel extends Model {
  async *_streamResponseChunks(messages: BaseMessage[], _options: unknown, runManager?: CallbackManagerForLLMRun) {
    for (const text of ['Reply ', String(messages.filter((message) => message.type === 'human').length)]) {
      const chunk = new ChatGenerationChunk({ message: new AIMessageChunk({ content: text }), text })
      await runManager?.handleLLMNewToken(text, undefined, undefined, undefined, undefined, { chunk })
      yield chunk
    }
  }
}

describe('Deep Agents through Manager', () => {
  test('streams once and resumes persisted native history in a new host', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'deep-runtime-'))
    const open = () =>
      RuntimeManager.open({
        dataDir: join(dir, 'manager'),
        runtimes: [new DeepAgentsRuntime({ dataDir: join(dir, 'native'), model: () => new StreamingModel({}) })]
      })
    let manager = await open()
    try {
      const project = await manager.createProject({ name: 'project' })
      const session = await manager.createSession({
        cwd: dir,
        model: 'fixture',
        projectId: project.id,
        runtime: 'deepagents'
      })
      const first = await manager.run(session.id, { text: 'first' })
      const events = await Array.fromAsync(manager.subscribe(first.runId))
      expect(
        events
          .filter((e) => e.event.type === 'TEXT_MESSAGE_CONTENT')
          .map((e) => ('delta' in e.event ? e.event.delta : ''))
          .join('')
      ).toBe('Reply 1')
      expect(events.filter((e) => e.event.type === 'RUN_FINISHED')).toHaveLength(1)
      expect(events.filter((e) => e.event.type === 'TEXT_MESSAGE_CONTENT')).toHaveLength(2)
      await manager.dispose()
      manager = await open()
      await manager.resumeSession(session.id)
      const second = await manager.run(session.id, { text: 'second' })
      const replay = await Array.fromAsync(manager.subscribe(second.runId))
      expect(
        replay
          .filter((e) => e.event.type === 'TEXT_MESSAGE_CONTENT')
          .map((e) => ('delta' in e.event ? e.event.delta : ''))
          .join('')
      ).toBe('Reply 2')
      expect((await manager.getRun(second.runId)).status).toBe('succeeded')
    } finally {
      await manager.dispose()
      await rm(dir, { force: true, recursive: true })
    }
  }, 30000)
  test('rejects missing native history without creating a replacement session', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'deep-missing-'))
    const adapter = new DeepAgentsRuntime({ dataDir: dir, model: () => new Model({}) })
    try {
      await expect(
        adapter.resumeSession({ cwd: dir, model: 'fixture', nativeSessionId: 'missing', options: {} })
      ).rejects.toMatchObject({ code: 'NATIVE_SESSION_MISSING' })
    } finally {
      await adapter.dispose()
      await rm(dir, { force: true, recursive: true })
    }
  })
  test('collects mixed approval decisions before executing only approved native tools', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'deep-approval-'))
    const effects: string[] = []
    const record = {
      description: 'Record effect',
      execute: ({ label }: Record<string, unknown>) => {
        effects.push(String(label))
        return String(label)
      },
      name: 'record_effect',
      schema: z.object({ label: z.string() })
    }
    const manager = await RuntimeManager.open({
      dataDir: join(dir, 'manager'),
      runtimes: [new DeepAgentsRuntime({ dataDir: join(dir, 'native'), model: () => new Model({}), tools: [record] })]
    })
    try {
      const project = await manager.createProject({ name: 'test' })
      const session = await manager.createSession({
        cwd: dir,
        model: 'fixture',
        projectId: project.id,
        runtime: 'deepagents'
      })
      const { runId } = await manager.run(session.id, { text: 'batch' })
      await expect.poll(async () => (await manager.listPendingApprovals(runId)).length).toBe(2)
      const pending = await manager.listPendingApprovals(runId)
      await manager.respondApproval(
        runId,
        z.string().parse(pending.find((item) => item.nativeRequestId === 'approved')?.id),
        'approve'
      )
      expect(effects).toEqual([])
      await manager.respondApproval(
        runId,
        z.string().parse(pending.find((item) => item.nativeRequestId === 'denied')?.id),
        'deny'
      )
      const events = await Array.fromAsync(manager.subscribe(runId))
      expect(effects).toEqual(['approved'])
      expect((await manager.getRun(runId)).status).toBe('succeeded')
      expect(events.filter((e) => e.event.type === 'TOOL_CALL_RESULT')).toHaveLength(2)
      expect(events.filter((e) => e.event.type === 'RUN_FINISHED')).toHaveLength(1)
      await expect(
        manager.respondApproval(
          runId,
          z.string().parse(pending.find((item) => item.nativeRequestId === 'approved')?.id),
          'approve'
        )
      ).rejects.toThrow()
    } finally {
      await manager.dispose()
      await rm(dir, { force: true, recursive: true })
    }
  }, 30000)

  test('answers input in the same run and cancels waiting work without replaying it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'deep-input-'))
    const open = () =>
      RuntimeManager.open({
        dataDir: join(dir, 'manager'),
        runtimes: [new DeepAgentsRuntime({ dataDir: join(dir, 'native'), model: () => new Model({}) })]
      })
    let manager = await open()
    try {
      const project = await manager.createProject({ name: 'test' })
      const session = await manager.createSession({
        cwd: dir,
        model: 'fixture',
        projectId: project.id,
        runtime: 'deepagents'
      })
      const { runId } = await manager.run(session.id, { text: 'input' })
      await expect.poll(async () => (await manager.listPendingInputs(runId)).length).toBe(1)
      expect((await manager.getRun(runId)).status).toBe('waiting_input')
      await expect(manager.run(session.id, { text: 'concurrent' })).rejects.toMatchObject({ code: 'SESSION_BUSY' })
      const [input] = await manager.listPendingInputs(runId)
      await manager.respondInput(runId, input?.id, { name: ['Ada'] })
      await Array.fromAsync(manager.subscribe(runId))
      expect((await manager.getRun(runId)).status).toBe('succeeded')
      const cancelled = await manager.run(session.id, { text: 'input' })
      await expect.poll(async () => (await manager.listPendingInputs(cancelled.runId)).length).toBe(1)
      await manager.cancel(cancelled.runId)
      await Array.fromAsync(manager.subscribe(cancelled.runId))
      expect((await manager.getRun(cancelled.runId)).status).toBe('cancelled')
      await manager.dispose()
      manager = await open()
      await expect(manager.resumeSession(session.id)).rejects.toMatchObject({ code: 'UNSAFE_RESUME' })
      expect(await manager.listPendingInputs(cancelled.runId)).toEqual([])
    } finally {
      await manager.dispose()
      await rm(dir, { force: true, recursive: true })
    }
  }, 30000)
  test('waits for cancelled tool cleanup and leaves other sessions usable', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'deep-cancel-'))
    const started = Promise.withResolvers<void>()
    let stopped = false
    let effect = false
    const slow = {
      description: 'Slow operation',
      execute: async (_: Record<string, unknown>, signal: AbortSignal) => {
        started.resolve()
        try {
          await setTimeout(60000, undefined, { signal })
          effect = true
          return 'done'
        } finally {
          await setTimeout(20)
          stopped = true
        }
      },
      name: 'slow_effect',
      schema: z.object({})
    }
    const manager = await RuntimeManager.open({
      dataDir: join(dir, 'manager'),
      runtimes: [
        new DeepAgentsRuntime({
          approvalTools: [],
          dataDir: join(dir, 'native'),
          model: () => new Model({}),
          tools: [slow]
        })
      ]
    })
    try {
      const project = await manager.createProject({ name: 'test' })
      const session = await manager.createSession({
        cwd: dir,
        model: 'fixture',
        projectId: project.id,
        runtime: 'deepagents'
      })
      const other = await manager.createSession({
        cwd: dir,
        model: 'fixture',
        projectId: project.id,
        runtime: 'deepagents'
      })
      const run = await manager.run(session.id, { text: 'slow' })
      await started.promise
      await manager.cancel(run.runId)
      await Array.fromAsync(manager.subscribe(run.runId))
      expect(stopped).toBe(true)
      expect(effect).toBe(false)
      expect((await manager.getRun(run.runId)).status).toBe('cancelled')
      const fresh = await manager.run(other.id, { text: 'hello' })
      await Array.fromAsync(manager.subscribe(fresh.runId))
      expect((await manager.getRun(fresh.runId)).status).toBe('succeeded')
      await expect(manager.resumeSession(session.id)).rejects.toMatchObject({ code: 'UNSAFE_RESUME' })
    } finally {
      await manager.dispose()
      await rm(dir, { force: true, recursive: true })
    }
  }, 30000)
  test('does not confirm cancellation when a tool ignores abort', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'deep-unsafe-'))
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<string>()
    const manager = await RuntimeManager.open({
      dataDir: join(dir, 'manager'),
      runtimes: [
        new DeepAgentsRuntime({
          approvalTools: [],
          dataDir: join(dir, 'native'),
          model: () => new Model({}),
          tools: [
            {
              description: 'Uncooperative tool',
              execute: () => {
                started.resolve()
                return release.promise
              },
              name: 'slow_effect',
              schema: z.object({})
            }
          ]
        })
      ]
    })
    try {
      const project = await manager.createProject({ name: 'test' })
      const session = await manager.createSession({
        cwd: dir,
        model: 'fixture',
        projectId: project.id,
        runtime: 'deepagents'
      })
      const run = await manager.run(session.id, { text: 'slow' })
      await started.promise
      await manager.cancel(run.runId)
      await Array.fromAsync(manager.subscribe(run.runId))
      expect(await manager.getRun(run.runId)).toMatchObject({
        error: { code: 'CANCELLATION_UNCONFIRMED' },
        status: 'failed'
      })
      await expect(manager.resumeSession(session.id)).rejects.toMatchObject({ code: 'UNSAFE_RESUME' })
    } finally {
      release.resolve('done')
      await manager.dispose()
      await rm(dir, { force: true, recursive: true })
    }
  }, 30000)
  test('fails explicitly when a native producer outruns a slow event sink', async () => {
    class BurstModel extends Model {
      async *_streamResponseChunks(_messages: BaseMessage[], _options: unknown, runManager?: CallbackManagerForLLMRun) {
        for (let i = 0; i < 1200; i++) {
          const chunk = new ChatGenerationChunk({ message: new AIMessageChunk({ content: 'x' }), text: 'x' })
          await runManager?.handleLLMNewToken('x', undefined, undefined, undefined, undefined, { chunk })
          yield chunk
        }
      }
    }
    const dir = await mkdtemp(join(tmpdir(), 'deep-overflow-'))
    const adapter = new DeepAgentsRuntime({ dataDir: dir, model: () => new BurstModel({}) })
    try {
      const session = await adapter.createSession({ cwd: dir, model: 'fixture' })
      await expect(
        adapter.execute(session, { runId: 'r', sessionId: 's', text: 'burst' }, async (notice) => {
          if (notice.kind === 'event') {
            await setTimeout(1)
          }
        })
      ).rejects.toMatchObject({ code: 'STREAM_OVERFLOW' })
    } finally {
      await adapter.dispose()
      await rm(dir, { force: true, recursive: true })
    }
  }, 30000)
  test('preserves structured text content as the final reply for memory', async () => {
    class BlocksModel extends Model {
      _generate() {
        const message = new AIMessage({ content: [{ text: 'final answer', type: 'text' }] })
        return Promise.resolve({ generations: [{ message, text: 'final answer' }] })
      }
    }
    const dir = await mkdtemp(join(tmpdir(), 'deep-blocks-'))
    const adapter = new DeepAgentsRuntime({ dataDir: dir, model: () => new BlocksModel({}) })
    try {
      const session = await adapter.createSession({ cwd: dir, model: 'fixture' })
      expect(
        await adapter.execute(session, { runId: 'r', sessionId: 's', text: 'question' }, () => Promise.resolve())
      ).toEqual({ finalReply: 'final answer', status: 'succeeded' })
    } finally {
      await adapter.dispose()
      await rm(dir, { force: true, recursive: true })
    }
  })
})
