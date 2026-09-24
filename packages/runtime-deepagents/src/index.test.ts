// cspell:ignore langgraph checkpointer
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BaseChatModel } from '@langchain/core/language_models/chat_models'
import { AIMessage, type BaseMessage } from '@langchain/core/messages'
import { RuntimeManager } from '@qingshaner/runtime'
import { describe, expect, test } from 'vitest'

import { DeepAgentsRuntime } from './index'

class Model extends BaseChatModel {
  _llmType() {
    return 'fixture'
  }
  bindTools() {
    return this
  }
  _generate(messages: BaseMessage[]) {
    const message = new AIMessage(`Reply ${messages.filter((m) => m.type === 'human').length}`)
    return Promise.resolve({ generations: [{ message, text: String(message.content) }] })
  }
}

describe('Deep Agents through Manager', () => {
  test('streams once and resumes persisted native history in a new host', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'deep-runtime-'))
    const open = () =>
      RuntimeManager.open({
        dataDir: join(dir, 'manager'),
        runtimes: [new DeepAgentsRuntime({ dataDir: join(dir, 'native'), model: () => new Model({}) })]
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
})
