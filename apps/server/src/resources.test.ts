import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Knowledge } from '@qingshaner/knowledge'
import { Mcp } from '@qingshaner/mcp'
import { MemoryCoreService, ProjectMemory } from '@qingshaner/memory'
import { ProjectResources } from '@qingshaner/runtime'
import { Skills } from '@qingshaner/skill'
import { expect, test } from 'vitest'

import { ManualAdapter } from '../../../packages/runtime/test/manual-adapter'
import { setupMemoryDatabase } from '../../../packages/runtime/test/memory-database.fixture'
import { openTestService } from '../test/service.fixture'

setupMemoryDatabase()

test('manages resources behind authentication, preserves imports and exposes safe memory failures', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'http-resources-'))
  const knowledge = await Knowledge.open(join(dir, 'knowledge'))
  const skills = await Skills.open(join(dir, 'skills'))
  const mcp = await Mcp.open(join(dir, 'mcp'))
  class Adapter extends ManualAdapter {
    configureProject = () => Promise.resolve()
  }
  const core = new MemoryCoreService({
    directory: join(dir, 'core'),
    gatewayApiKeyEnv: 'HTTP_MEMORY_TEST',
    model: { apiKeyEnv: 'HTTP_MEMORY_TEST', baseUrl: 'http://127.0.0.1:1', name: 'test' },
    serviceId: 'test'
  })
  const adapter = new Adapter()
  const server = await openTestService({
    dataDir: join(dir, 'db'),
    memory: new ProjectMemory({
      apiKeyEnv: 'HTTP_MEMORY_TEST',
      endpoint: 'http://127.0.0.1:1',
      serviceId: 'test',
      timeoutMs: 30
    }),
    memoryCore: core,
    resources: new ProjectResources({ knowledge, mcp, skills }),
    runtimes: [adapter]
  })
  const fetch = server.fetch
  const request = (path: string, method = 'GET', body?: unknown) =>
    fetch(server.url + path, {
      headers: { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' },
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    })
  try {
    expect((await fetch(`${server.url}/memory-core`)).status).toBe(401)
    await request('/projects', 'POST', { id: 'p', name: 'p' })
    await mkdir(join(dir, 'docs'))
    expect((await request('/projects/p/knowledge/binding', 'POST', { directory: join(dir, 'docs') })).status).toBe(200)
    expect(
      (await request('/projects/p/knowledge/documents', 'POST', { content: 'hello', path: 'one.md' })).status
    ).toBe(200)
    expect(await (await request('/projects/p/knowledge/documents?path=one.md')).json()).toEqual({ content: 'hello' })
    expect((await request('/projects/p/knowledge/documents?path=../escape.md')).status).toBe(400)
    await mkdir(join(dir, 'source'))
    await writeFile(join(dir, 'source/SKILL.md'), '---\nname: test\ndescription: test\n---\nBody')
    const skill = (await (await request('/skills', 'POST', { source: join(dir, 'source') })).json()) as { id: string }
    expect((await request(`/projects/p/skills/${skill.id}`, 'POST', { enabled: true })).status).toBe(200)
    expect((await request(`/skills/${skill.id}`, 'DELETE')).status).toBe(200)
    expect(await readFile(join(dir, 'source/SKILL.md'), 'utf8')).toContain('Body')
    const config = (await (
      await request('/mcp', 'POST', {
        headers: { Authorization: 'HTTP_MEMORY_TEST' },
        name: 'disabled',
        transport: 'http',
        url: 'http://127.0.0.1:1'
      })
    ).json()) as { id: string }
    expect((await request(`/projects/p/mcp/${config.id}`, 'POST', { enabled: false })).status).toBe(200)
    expect(await (await request('/projects/p/mcp')).json()).toMatchObject([{ enabled: false, id: config.id }])
    await request('/projects', 'POST', { id: 'other', name: 'other' })
    expect(await (await request('/projects/other/mcp')).json()).toEqual([])
    const session = (await (
      await request('/sessions', 'POST', { cwd: dir, model: 'test', projectId: 'p', runtime: 'manual' })
    ).json()) as { id: string }
    const run = (await (await request(`/sessions/${session.id}/runs`, 'POST', { text: 'new input' })).json()) as {
      runId: string
    }
    await adapter.waitStarted(run.runId)
    adapter.finish(run.runId, { finalReply: 'answer', status: 'succeeded' })
    await (await request(`/runs/${run.runId}/events`)).text()
    await expect
      .poll(
        async () => ((await (await request(`/runs/${run.runId}/memory-write`)).json()) as { status: string }).status
      )
      .toBe('failed')
    expect(await (await request(`/runs/${run.runId}`)).json()).toMatchObject({
      memoryError: { code: 'MEMORY_RECALL_FAILED' },
      status: 'succeeded'
    })
    const status = await (await request('/memory-core')).json()
    expect(status).toMatchObject({ owned: false, phase: 'not_installed', version: '1.0.2-beta.1' })
    expect((await request('/memory-core/start', 'POST', {})).status).toBe(409)
    expect((await request('/memory-core/stop', 'POST', {})).status).toBe(200)
    expect((await request('/memory-core/install', 'POST', { archivePath: join(dir, 'missing.tgz') })).status).toBe(409)
    expect(await (await request('/memory-core')).json()).toMatchObject({ owned: false, phase: 'failed' })
    expect(await (await request('/projects/p/memory')).json()).toMatchObject({
      code: 'CONFLICT',
      data: { code: 'MISSING_CREDENTIAL' }
    })
    process.env.HTTP_MEMORY_TEST = 'private-value'
    expect(await (await request('/projects/p/memory')).json()).toMatchObject({
      code: 'CONFLICT',
      data: { code: 'MEMORY_UNAVAILABLE' }
    })
    expect((await request('/projects/p/memory?limit=-1')).status).toBe(400)
    delete process.env.HTTP_MEMORY_TEST
    expect(await (await request('/projects/p/memory-writes')).json()).toMatchObject([
      { runId: run.runId, status: 'failed' }
    ])
    expect(
      (await request('/mcp', 'POST', { name: 'bad', transport: 'http', url: 'http://user:secret@example.com' })).status
    ).toBe(400)
  } finally {
    await server.close()
    await mcp.dispose()
    await rm(dir, { force: true, recursive: true })
  }
}, 20000)
