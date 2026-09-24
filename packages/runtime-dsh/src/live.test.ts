// biome-ignore-all lint/suspicious/noMisplacedAssertion: Vitest opt-in test.skipIf callback.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { Knowledge } from '@qingshaner/knowledge'
import { Mcp } from '@qingshaner/mcp'
import { ProjectResources, RuntimeManager } from '@qingshaner/runtime'
import { Skills } from '@qingshaner/skill'
import { expect, test } from 'vitest'

import { drive } from '../test/fixture'
import { httpTool } from '../test/mcp'
import { DshRuntime } from './index'

test.skipIf(process.env.DSH_LIVE !== '1')(
  'hosted DSH executes project tools, asks input and resumes history',
  async () => {
    const model = process.env.DSH_MODEL
    if (!(model && process.env.DEEPSEEK_API_KEY)) {
      throw new Error('Explicit DSH_MODEL and DEEPSEEK_API_KEY required')
    }
    const root = await mkdtemp(join(tmpdir(), 'dsh-hosted-'))
    const http = await httpTool()
    const knowledge = await Knowledge.open(join(root, 'knowledge'))
    const skills = await Skills.open(join(root, 'skills'))
    const mcp = await Mcp.open(join(root, 'mcp'))
    const open = () =>
      RuntimeManager.open({
        dataDir: join(root, 'manager'),
        resources: new ProjectResources({ knowledge, mcp, skills }),
        runtimes: [new DshRuntime({ baseURL: process.env.DEEPSEEK_BASE_URL, dataDir: join(root, 'native') })]
      })
    let manager = await open()
    try {
      await mkdir(join(root, 'docs'))
      await knowledge.bind('project', join(root, 'docs'))
      await knowledge.create('project', 'proof.md', 'document secret: aurora-391')
      await mkdir(join(root, 'source'))
      await writeFile(
        join(root, 'source', 'SKILL.md'),
        '---\nname: proof-skill\ndescription: Use this skill for the hosted resource proof.\n---\nskill secret: willow-827. Follow the user requested tool sequence.'
      )
      const skill = await skills.import(join(root, 'source'))
      await skills.bind('project', skill.id, true)
      const local = await mcp.create({
        args: [resolve(import.meta.dirname, '../../mcp/test/server.fixture.ts')],
        command: process.execPath,
        name: 'local',
        transport: 'stdio'
      })
      const remote = await mcp.create({ name: 'http', transport: 'http', url: http.url })
      await mcp.bind('project', local.id, true)
      await mcp.bind('project', remote.id, true)
      await manager.createProject({ id: 'project', name: 'Project' })
      const session = await manager.createSession({ cwd: root, model, projectId: 'project', runtime: 'dsh' })
      const { runId } = await manager.run(session.id, {
        text: 'Verification task: first call skill with name proof-skill. Call mcp__project__knowledge_read with path proof.md. Call mcp__project__echo with proof set to the document secret and mcp__project__http_echo with fail:false. Use ask_user_question with a single question id color asking which color to remember. After the answer, return the two secrets and color. Do not use bash or other tools.'
      })
      let inputs = 0
      const events = await drive(
        manager,
        runId,
        async (approval) =>
          ['skill', 'mcp__project__knowledge_read', 'mcp__project__echo', 'mcp__project__http_echo'].includes(
            String(approval.detail.name)
          )
            ? 'approve'
            : 'deny',
        (input) => {
          inputs++
          return Object.fromEntries(input.questions.map((question) => [question.id, ['violet']]))
        }
      )
      const tools = events.flatMap(({ event }) => (event.type === 'TOOL_CALL_START' ? [event.toolCallName] : []))
      const text = events.map(({ event }) => (event.type === 'TEXT_MESSAGE_CONTENT' ? event.delta : '')).join('')
      expect((await manager.getRun(runId)).status).toBe('succeeded')
      expect([...tools]).toEqual(
        expect.arrayContaining([
          'skill',
          'mcp__project__knowledge_read',
          'mcp__project__echo',
          'mcp__project__http_echo',
          'ask_user_question'
        ])
      )
      expect(inputs).toBeGreaterThan(0)
      expect(text).toContain('aurora-391')
      expect(text).toContain('willow-827')
      expect(text.toLowerCase()).toContain('violet')
      expect(http.calls()).toBeGreaterThan(0)
      await manager.dispose()
      manager = await open()
      await manager.resumeSession(session.id)
      const next = await manager.run(session.id, {
        text: 'Without tools, state the color and both secrets from our previous turn.'
      })
      const replayed = await drive(manager, next.runId, async () => 'deny')
      const recalled = replayed.map(({ event }) => (event.type === 'TEXT_MESSAGE_CONTENT' ? event.delta : '')).join('')
      expect((await manager.getRun(next.runId)).status).toBe('succeeded')
      expect(recalled.toLowerCase()).toContain('violet')
      expect(recalled).toContain('aurora-391')
      expect(recalled).toContain('willow-827')
    } finally {
      await manager.dispose()
      await mcp.dispose()
      await http.close()
      await rm(root, { force: true, recursive: true })
    }
  },
  240000
)
