import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { Knowledge } from '@qingshaner/knowledge'
import { Mcp } from '@qingshaner/mcp'
import { Skills } from '@qingshaner/skill'
import { expect, test, vi } from 'vitest'

import { ManualAdapter } from '../test/manual-adapter'
import { RuntimeManager } from './manager'
import { ProjectResources } from './resources'

import type { ResourceSnapshot } from './resources'

test('assembles only project enabled resources and reads complete current knowledge through MCP', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'runtime-resources-'))
  const knowledge = await Knowledge.open(join(dir, 'knowledge'))
  const skills = await Skills.open(join(dir, 'skills'))
  const mcp = await Mcp.open(join(dir, 'mcp'))
  const resources = new ProjectResources({ knowledge, mcp, skills })
  const client = await Mcp.open(join(dir, 'client'))
  try {
    await mkdir(join(dir, 'docs'))
    await knowledge.bind('p', join(dir, 'docs'))
    await knowledge.create('p', 'one.md', 'old text')
    await mkdir(join(dir, 'source'))
    await writeFile(join(dir, 'source/SKILL.md'), '---\nname: selected\ndescription: test skill\n---\nOnly this skill')
    const skill = await skills.import(join(dir, 'source'))
    await skills.bind('p', skill.id, true)
    const snapshot = await resources.prepare('p')
    expect(snapshot.skillDirectories).toEqual([skill.directory])
    expect((await resources.prepare('other')).skillDirectories).toEqual([])
    process.env.RESOURCE_TEST_TOKEN = snapshot.token
    const server = await client.create({
      headers: { Authorization: 'RESOURCE_TEST_TOKEN' },
      name: 'resources',
      transport: 'http',
      url: snapshot.url
    })
    await client.bind('p', server.id, true)
    const connection = await client.connect('p')
    expect(connection.tools.map(({ name }) => name)).toEqual(['knowledge_search', 'knowledge_read'])
    await knowledge.edit('p', 'one.md', 'new complete text')
    expect(await connection.callTool('knowledge_read', { path: 'one.md' })).toMatchObject({
      content: [{ text: 'new complete text' }]
    })
    expect(await connection.callTool('knowledge_read', { path: '../escape.md' })).toMatchObject({ isError: true })
    await connection.close()
  } finally {
    await client.dispose()
    await resources.dispose()
    await mcp.dispose()
    delete process.env.RESOURCE_TEST_TOKEN
    await rm(dir, { force: true, recursive: true })
  }
})

test('drains waiting input before changes, keeps controls available and fails preparation before execution', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'runtime-resource-drain-'))
  const skills = await Skills.open(join(dir, 'skills'))
  const resources = new ProjectResources({ skills })
  class Adapter extends ManualAdapter {
    snapshots: ResourceSnapshot[] = []
    configureProject = (_projectId: string, snapshot: ResourceSnapshot) => {
      this.snapshots.push(snapshot)
      return Promise.resolve()
    }
  }
  const adapter = new Adapter()
  const manager = await RuntimeManager.open({ dataDir: join(dir, 'db'), resources, runtimes: [adapter] })
  try {
    await manager.createProject({ id: 'p', name: 'p' })
    const session = await manager.createSession({ cwd: dir, model: 'test', projectId: 'p', runtime: 'manual' })
    const { runId } = await manager.run(session.id, { text: 'question' })
    await adapter.waitStarted(runId)
    await adapter.push(runId, {
      kind: 'input',
      request: { nativeRequestId: 'input', questions: [{ header: 'Choice', id: 'q', question: 'Which?' }] }
    })
    let changed = false
    const updating = manager.updateProjectResources('p', () => {
      changed = true
      return Promise.resolve()
    })
    await expect(manager.run(session.id, { text: 'blocked' })).rejects.toMatchObject({ code: 'RESOURCES_UPDATING' })
    expect(changed).toBe(false)
    const [request] = await manager.listPendingInputs(runId)
    if (!request) {
      throw new Error('Missing input')
    }
    await manager.respondInput(runId, request.id, { q: ['answer'] })
    await manager.cancel(runId)
    await updating
    expect(changed).toBe(true)
    expect(new Set(adapter.snapshots.map(({ url }) => url)).size).toBe(2)
    await mkdir(join(dir, 'source'))
    await writeFile(join(dir, 'source/SKILL.md'), '---\nname: broken\ndescription: test\n---\nBody')
    const skill = await skills.import(join(dir, 'source'))
    await skills.bind('p', skill.id, true)
    await rm(skill.directory, { recursive: true })
    const failed = await manager.run(session.id, { text: 'cannot execute' })
    await Array.fromAsync(manager.subscribe(failed.runId))
    expect(await manager.getRun(failed.runId)).toMatchObject({
      error: { code: 'RESOURCE_PREPARATION_FAILED' },
      status: 'failed'
    })
    expect(adapter.executions.has(failed.runId)).toBe(false)
  } finally {
    await manager.dispose()
    await rm(dir, { force: true, recursive: true })
  }
})

test('disposal owns preparation before connections are acquired', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'runtime-resources-'))
  const knowledge = await Knowledge.open(dir)
  const entered = Promise.withResolvers<void>()
  const gate = Promise.withResolvers<string>()
  vi.spyOn(knowledge, 'binding').mockImplementationOnce(() => {
    entered.resolve()
    return gate.promise
  })
  const resources = new ProjectResources({ knowledge })
  const preparing = resources.prepare('p')
  const rejected = expect(preparing).rejects.toMatchObject({ code: 'DISPOSED' })
  await entered.promise
  const closing = resources.dispose()
  gate.resolve(dir)
  await rejected
  await closing
  await expect(resources.prepare('p')).rejects.toMatchObject({ code: 'DISPOSED' })
  await rm(dir, { force: true, recursive: true })
})

test('checks the actual upstream connection and blocks the next run after a protocol failure', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'runtime-resource-health-'))
  const mcp = await Mcp.open(join(dir, 'upstream'))
  const local = await mcp.create({
    args: [resolve(import.meta.dirname, '../../mcp/test/server.fixture.ts')],
    command: process.execPath,
    name: 'fixture',
    transport: 'stdio'
  })
  await mcp.bind('p', local.id, true)
  const resources = new ProjectResources({ mcp })
  const client = await Mcp.open(join(dir, 'client'))
  try {
    const snapshot = await resources.prepare('p')
    process.env.RESOURCE_TEST_TOKEN = snapshot.token
    const bridge = await client.create({
      headers: { Authorization: 'RESOURCE_TEST_TOKEN' },
      name: 'bridge',
      transport: 'http',
      url: snapshot.url
    })
    await client.bind('p', bridge.id, true)
    const connection = await client.connect('p')
    expect(await connection.callTool('echo', { fail: true })).toMatchObject({ isError: true })
    await expect(resources.prepare('p')).rejects.toMatchObject({ code: 'DISPOSED' })
    await resources.release('p')
    expect((await resources.prepare('p')).url).not.toEqual(snapshot.url)
  } finally {
    await client.dispose()
    await resources.dispose()
    await mcp.dispose()
    delete process.env.RESOURCE_TEST_TOKEN
    await rm(dir, { force: true, recursive: true })
  }
})

test('shared mutation gates project creation and binding before enumeration and drains active runs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'runtime-shared-update-'))
  const adapter = new ManualAdapter()
  const manager = await RuntimeManager.open({ dataDir: dir, runtimes: [adapter] })
  try {
    await manager.createProject({ id: 'p', name: 'p' })
    const session = await manager.createSession({ cwd: dir, model: 'test', projectId: 'p', runtime: 'manual' })
    const { runId } = await manager.run(session.id, { text: 'waiting' })
    await adapter.waitStarted(runId)
    let changed = false
    const updating = manager.updateSharedResources(() => {
      changed = true
      return Promise.resolve()
    })
    await expect(manager.createProject({ id: 'late', name: 'late' })).rejects.toMatchObject({
      code: 'RESOURCES_UPDATING'
    })
    expect(() => manager.updateProjectResources('p', () => Promise.resolve())).toThrow(
      expect.objectContaining({ code: 'RESOURCES_UPDATING' })
    )
    await expect(manager.run(session.id, { text: 'late' })).rejects.toMatchObject({ code: 'RESOURCES_UPDATING' })
    expect(changed).toBe(false)
    await manager.cancel(runId)
    await updating
    expect(changed).toBe(true)
    expect((await manager.createProject({ id: 'late', name: 'late' })).id).toBe('late')
  } finally {
    await manager.dispose()
    await rm(dir, { force: true, recursive: true })
  }
})
