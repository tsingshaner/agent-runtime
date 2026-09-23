import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'vitest'
import * as z from 'zod/mini'

import { ManualAdapter } from '../../../packages/runtime/test/manual-adapter'
import { openTestService } from '../test/service.fixture'

describe('HTTP contract', () => {
  test('serves authenticated OpenAPI with concrete resource and event schemas', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'runtime-contract-'))
    const server = await openTestService({ dataDir: directory, runtimes: [new ManualAdapter()] })
    const fetch = server.fetch
    try {
      expect((await fetch(`${server.url}/spec.json`)).status).toBe(401)
      const response = await fetch(`${server.url}/spec.json`, { headers: { authorization: `Bearer ${server.token}` } })
      expect(response.status).toBe(200)
      const spec = z.parse(
        z.object({
          paths: z.record(z.string(), z.record(z.string(), z.unknown())),
          security: z.array(z.record(z.string(), z.array(z.string())))
        }),
        await response.json()
      )
      expect(spec.security).toEqual([{ bearerAuth: [] }])
      const operations = Object.values(spec.paths).flatMap((path) =>
        Object.entries(path)
          .filter(([method]) => ['get', 'post', 'patch', 'delete'].includes(method))
          .map(([, operation]) =>
            z.parse(
              z.object({
                description: z.string().check(z.minLength(1)),
                operationId: z.string().check(z.minLength(1)),
                summary: z.string().check(z.minLength(1)),
                tags: z.array(z.string().check(z.minLength(1))).check(z.minLength(1))
              }),
              operation
            )
          )
      )
      const operationIds = operations.map((operation) => operation.operationId)
      expect(operationIds.length).toBeGreaterThan(0)
      expect(new Set(operationIds).size).toBe(operationIds.length)
      expect(operationIds).toEqual(
        expect.arrayContaining([
          'subscribeRunEvents',
          'submitSessionRun',
          'bindProjectSkill',
          'listProjectSkills',
          'unbindProjectSkill',
          'bindProjectMcpServer',
          'listProjectMcpServers',
          'unbindProjectMcpServer'
        ])
      )

      expect(spec.paths['/projects']).toMatchObject({
        post: {
          requestBody: { content: { 'application/json': { schema: { properties: { name: { type: 'string' } } } } } }
        }
      })
      expect(spec.paths['/sessions/{id}/runs']).toHaveProperty(
        'post.responses.200.content.application/json.schema.properties.runId.type',
        'string'
      )
      expect(spec.paths['/runs/{id}/events']).toHaveProperty('get.responses.200.content.text/event-stream')
      expect(spec.paths).toHaveProperty('/projects/{id}/memory/core')
      expect(JSON.stringify(spec)).not.toContain(server.token)
    } finally {
      await server.close()
      await rm(directory, { force: true, recursive: true })
    }
  }, 20000)

  test('bounds request bodies and omits validation input values from errors', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'runtime-contract-input-'))
    const server = await openTestService({ dataDir: directory, runtimes: [new ManualAdapter()] })
    const fetch = server.fetch
    try {
      const headers = { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' }
      const invalid = await fetch(`${server.url}/projects`, {
        body: JSON.stringify({ name: { secret: 'do-not-echo' } }),
        headers,
        method: 'POST'
      })
      expect(invalid.status).toBe(400)
      const error = await invalid.text()
      expect(error).not.toContain('do-not-echo')
      expect(JSON.parse(error)).toMatchObject({ code: 'BAD_REQUEST' })
      const large = await fetch(`${server.url}/projects`, {
        body: JSON.stringify({ name: 'a'.repeat(1024 * 1024) }),
        headers,
        method: 'POST'
      })
      expect(large.status).toBe(413)
    } finally {
      await server.close()
      await rm(directory, { force: true, recursive: true })
    }
  }, 20000)
})
