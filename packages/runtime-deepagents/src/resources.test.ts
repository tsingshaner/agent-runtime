import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { BaseChatModel } from '@langchain/core/language_models/chat_models'
import { AIMessage, type BaseMessage } from '@langchain/core/messages'
import { Knowledge } from '@qingshaner/knowledge'
import { Mcp } from '@qingshaner/mcp'
import { ProjectResources, RuntimeManager } from '@qingshaner/runtime'
import { Skills } from '@qingshaner/skill'
import { describe, expect, test } from 'vitest'

import { DeepAgentsRuntime } from './index'

class ResourceModel extends BaseChatModel {
  prompts: string[] = []
  _llmType() {
    return 'resources'
  }
  bindTools() {
    return this
  }
  _generate(messages: BaseMessage[]) {
    this.prompts.push(
      messages
        .filter((m) => m.type === 'system')
        .map((m) => m.content)
        .join('\n')
    )
    const last = messages.at(-1)
    const request =
      typeof last?.content === 'string' && last.content.startsWith('{')
        ? JSON.parse(last.content)
        : { args: { path: String(last?.content) }, name: 'knowledge_read' }
    const message =
      last?.type === 'human'
        ? new AIMessage({
            content: '',
            tool_calls: [{ args: request.args, id: 'read', name: request.name, type: 'tool_call' }]
          })
        : new AIMessage(String(last?.content))
    return Promise.resolve({ generations: [{ message, text: String(message.content) }] })
  }
}

describe('Deep Agents project resources', () => {
  test('reads project knowledge and applies explicit skills on the next run without losing history', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'deep-resources-'))
    const knowledge = await Knowledge.open(join(dir, 'knowledge'))
    const skills = await Skills.open(join(dir, 'skills'))
    const model = new ResourceModel({})
    const manager = await RuntimeManager.open({
      dataDir: join(dir, 'manager'),
      resources: new ProjectResources({ knowledge, skills }),
      runtimes: [new DeepAgentsRuntime({ dataDir: join(dir, 'native'), model: () => model })]
    })
    try {
      const project = await manager.createProject({ name: 'test' })
      await mkdir(join(dir, 'docs'))
      await knowledge.bind(project.id, join(dir, 'docs'))
      await knowledge.create(project.id, 'one.md', 'project-secret')
      await mkdir(join(dir, 'source'))
      await writeFile(
        join(dir, 'source/SKILL.md'),
        '---\nname: selected\ndescription: Only selected skill\n---\nUse project knowledge.'
      )
      const skill = await skills.import(join(dir, 'source'))
      await skills.bind(project.id, skill.id, true)
      const session = await manager.createSession({
        cwd: dir,
        model: 'fixture',
        projectId: project.id,
        runtime: 'deepagents'
      })
      const run = await manager.run(session.id, { text: 'one.md' })
      const events = await Array.fromAsync(manager.subscribe(run.runId))
      expect((await manager.getRun(run.runId)).status).toBe('succeeded')
      expect(
        events.some((e) => e.event.type === 'TOOL_CALL_RESULT' && e.event.content.includes('project-secret'))
      ).toBe(true)
      expect(model.prompts.at(-1)).toContain('Only selected skill')
      const readSkill = await manager.run(session.id, {
        text: JSON.stringify({ args: { file_path: join(skill.directory, 'SKILL.md') }, name: 'read_file' })
      })
      const skillEvents = await Array.fromAsync(manager.subscribe(readSkill.runId))
      expect(
        skillEvents.some(
          (event) => event.event.type === 'TOOL_CALL_RESULT' && event.event.content.includes('Use project knowledge.')
        )
      ).toBe(true)
      await manager.updateProjectResources(project.id, async () => {
        await skills.bind(project.id, skill.id, false)
        await knowledge.edit(project.id, 'one.md', 'updated')
      })
      const second = await manager.run(session.id, { text: 'one.md' })
      const next = await Array.fromAsync(manager.subscribe(second.runId))
      expect(await manager.getRun(second.runId)).toMatchObject({ status: 'succeeded' })
      expect(next.some((e) => e.event.type === 'TOOL_CALL_RESULT' && e.event.content.includes('updated'))).toBe(true)
      expect(model.prompts.at(-1)).not.toContain('Only selected skill')
    } finally {
      await manager.dispose()
      await rm(dir, { force: true, recursive: true })
    }
  }, 30000)
  test.each(['stdio', 'http'] as const)(
    'calls real %s MCP tools and returns ordinary failures to the model',
    async (transport) => {
      const dir = await mkdtemp(join(tmpdir(), 'deep-mcp-'))
      const mcp = await Mcp.open(join(dir, 'mcp'))
      const upstream = await Mcp.open(join(dir, 'upstream'))
      const bridge = new ProjectResources({ mcp: upstream })
      const manager = await RuntimeManager.open({
        dataDir: join(dir, 'manager'),
        resources: new ProjectResources({ mcp }),
        runtimes: [
          new DeepAgentsRuntime({ approvalTools: [], dataDir: join(dir, 'native'), model: () => new ResourceModel({}) })
        ]
      })
      try {
        const project = await manager.createProject({ name: 'test' })
        const stdio = {
          args: [resolve(import.meta.dirname, '../../mcp/test/server.fixture.ts')],
          command: process.execPath,
          name: 'echo-tools',
          transport: 'stdio' as const
        }
        let entry: Awaited<ReturnType<Mcp['create']>>
        if (transport === 'stdio') {
          entry = await mcp.create(stdio)
        } else {
          const source = await upstream.create(stdio)
          await upstream.bind('upstream', source.id, true)
          const snapshot = await bridge.prepare('upstream')
          process.env.DEEP_TEST_BRIDGE_TOKEN = snapshot.token
          entry = await mcp.create({
            headers: { Authorization: 'DEEP_TEST_BRIDGE_TOKEN' },
            name: 'http-tools',
            transport: 'http',
            url: snapshot.url
          })
        }
        await mcp.bind(project.id, entry.id, true)
        const session = await manager.createSession({
          cwd: dir,
          model: 'fixture',
          projectId: project.id,
          runtime: 'deepagents'
        })
        const first = await manager.run(session.id, {
          text: JSON.stringify({ args: { text: 'real-tool' }, name: 'echo' })
        })
        const events = await Array.fromAsync(manager.subscribe(first.runId))
        expect((await manager.getRun(first.runId)).status).toBe('succeeded')
        expect(events.some((e) => e.event.type === 'TOOL_CALL_RESULT' && e.event.content.includes('real-tool'))).toBe(
          true
        )
        const failure = await manager.run(session.id, { text: JSON.stringify({ args: { fail: true }, name: 'echo' }) })
        const failedTool = await Array.fromAsync(manager.subscribe(failure.runId))
        expect((await manager.getRun(failure.runId)).status).toBe('succeeded')
        expect(
          failedTool.some((e) => e.event.type === 'TOOL_CALL_RESULT' && e.event.content.includes('Tool failed'))
        ).toBe(true)
      } finally {
        await manager.dispose()
        await bridge.dispose()
        await mcp.dispose()
        await upstream.dispose()
        delete process.env.DEEP_TEST_BRIDGE_TOKEN
        await rm(dir, { force: true, recursive: true })
      }
    },
    30000
  )
})
