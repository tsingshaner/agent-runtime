// cspell:ignore unstub
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { Knowledge } from '@qingshaner/knowledge'
import { Mcp } from '@qingshaner/mcp'
import { ProjectResources } from '@qingshaner/runtime'
import { Skills } from '@qingshaner/skill'
import { describe, expect, test, vi } from 'vitest'

import { drive, fixture } from '../test/fixture'
import { httpTool } from '../test/mcp'

describe('DSH project resources', () => {
  test('loads only enabled skills and calls current project knowledge through native MCP', async () => {
    vi.stubEnv('DSH_TEST_KEY', 'fixture')
    const prompts: string[] = []
    const http = await httpTool()
    let skills: Skills
    let selected = ''
    const f = await fixture(
      (body, i) => {
        prompts.push(JSON.stringify(body))
        if (i === 1) {
          return { arguments: { path: 'proof.md' }, name: 'mcp__project__knowledge_read' }
        }
        if (i === 2 || i === 7) {
          return { arguments: { name: 'selected-skill' }, name: 'skill' }
        }
        if (i === 3) {
          return { arguments: { proof: 'stdio-proof' }, name: 'mcp__project__echo' }
        }
        if (i === 4 || i === 5) {
          return { arguments: { fail: i === 5 }, name: 'mcp__project__http_echo' }
        }
        return 'resource-proof'
      },
      async (root) => {
        const knowledge = await Knowledge.open(join(root, 'knowledge'))
        skills = await Skills.open(join(root, 'skills'))
        await mkdir(join(root, 'docs'))
        await knowledge.bind('project', join(root, 'docs'))
        await knowledge.create('project', 'proof.md', 'project-document-secret')
        await mkdir(join(root, 'source'))
        await writeFile(
          join(root, 'source', 'SKILL.md'),
          '---\nname: selected-skill\ndescription: managed skill\n---\nselected-skill-secret'
        )
        const imported = await skills.import(join(root, 'source'))
        selected = imported.id
        await skills.bind('project', selected, true)
        await mkdir(join(root, '.agents', 'skills', 'global-skill'), { recursive: true })
        await writeFile(
          join(root, '.agents', 'skills', 'global-skill', 'SKILL.md'),
          '---\nname: forbidden-global\ndescription: must not load\n---\nforbidden-global-secret'
        )
        const mcp = await Mcp.open(join(root, 'mcp'))
        const local = await mcp.create({
          args: [resolve(import.meta.dirname, '../../mcp/test/server.fixture.ts')],
          command: process.execPath,
          name: 'local',
          transport: 'stdio'
        })
        const remote = await mcp.create({ name: 'http', transport: 'http', url: http.url })
        await mcp.bind('project', local.id, true)
        await mcp.bind('project', remote.id, true)
        return new ProjectResources({ knowledge, mcp, skills })
      }
    )
    try {
      const session = await f.create()
      const { runId } = await f.manager.run(session.id, { text: 'Use selected resources' })
      let updating: Promise<void> | undefined
      let changed = false
      await drive(f.manager, runId, async () => {
        if (!updating) {
          updating = f.manager.updateProjectResources('project', async () => {
            changed = true
            await skills.bind('project', selected, false)
          })
          await expect(f.manager.run(session.id, { text: 'must reject admission' })).rejects.toMatchObject({
            code: 'RESOURCES_UPDATING'
          })
          expect(changed).toBe(false)
        }
        return 'approve'
      })
      expect((await f.manager.getRun(runId)).status).toBe('succeeded')
      expect(prompts[0]).toContain('selected-skill')
      expect(prompts[0]).not.toContain('forbidden-global')
      expect(prompts[1]).toContain('project-document-secret')
      expect(prompts[2]).toContain('selected-skill-secret')
      expect(prompts[3]).toContain('stdio-proof')
      expect(prompts[4]).toContain('http-proof')
      expect(prompts[5]).toContain('ordinary-http-error')
      expect(http.calls()).toBe(2)
      await updating
      expect(changed).toBe(true)
      const toolResult = JSON.parse(prompts[3] ?? '{}').messages.find(
        (message: { tool_call_id?: string }) => message.tool_call_id === 'call-3'
      )
      const nativeToolPid = JSON.parse(toolResult.content).pid as number
      expect(() => process.kill(nativeToolPid, 0)).toThrow()
      const next = await f.manager.run(session.id, { text: 'After resource update' })
      await drive(f.manager, next.runId)
      expect(prompts[7]).toContain('unknown or no longer available')
      await f.manager.createProject({ id: 'other', name: 'Other' })
      const other = await f.manager.createSession({
        cwd: f.root,
        model: 'deepseek-v4-flash',
        projectId: 'other',
        runtime: 'dsh'
      })
      const isolated = await f.manager.run(other.id, { text: 'isolation probe' })
      await Array.fromAsync(f.manager.subscribe(isolated.runId))
      expect(prompts.at(-1)).not.toContain('selected-skill')
      expect(prompts.at(-1)).not.toContain('knowledge_read')
      expect(prompts.at(-1)).not.toContain('project-document-secret')
      expect((await f.manager.getRun(next.runId)).status).toBe('succeeded')
      expect((await f.manager.getSession(session.id)).nativeSessionId).toBe(session.nativeSessionId)
    } finally {
      await f.close()
      await http.close()
      vi.unstubAllEnvs()
    }
  }, 60000)
})
