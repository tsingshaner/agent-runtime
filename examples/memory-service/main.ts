// biome-ignore-all lint/suspicious/noConsole: Standalone opt-in smoke report.
// biome-ignore-all lint/suspicious/noMisplacedAssertion: Public lifecycle and real SDK smoke assertions.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { MemoryClient } from '@tencentdb-agent-memory/memory-sdk-ts-v2'

if (process.env.RUN_MEMORY_SERVICE_SMOKE !== '1') {
  console.log('SKIPPED: set RUN_MEMORY_SERVICE_SMOKE=1 to install and run the real MemoryCore')
} else {
  const { MemoryCoreService } = await import('@qingshaner/memory')
  const { MEMORY_MODEL: model, MEMORY_BASE_URL: baseUrl, MEMORY_API_KEY_ENV: apiKeyEnv } = process.env
  assert(model && baseUrl && apiKeyEnv, 'Set MEMORY_MODEL, MEMORY_BASE_URL and MEMORY_API_KEY_ENV explicitly')
  const directory = process.env.MEMORY_SERVICE_DIR ?? (await mkdtemp(join(tmpdir(), 'memory-service-smoke-')))
  const token = randomUUID()
  const credentialEnv = `MEMORY_SMOKE_${randomUUID().replaceAll('-', '')}`
  process.env[credentialEnv] = token
  const service = new MemoryCoreService({
    directory,
    endpoint: process.env.MEMORY_ENDPOINT ?? 'http://127.0.0.1:8420',
    gatewayApiKeyEnv: credentialEnv,
    model: { apiKeyEnv, baseUrl, name: model },
    serviceId: 'agent-runtime-smoke'
  })
  try {
    await service.install()
    await service.install({ archivePath: '/does-not-exist' })
    const ready = await service.start()
    assert.equal(ready.phase, 'running')
    assert.deepEqual(await service.start(), ready)
    const client = new MemoryClient({
      agentId: 'agent-runtime',
      apiKey: token,
      endpoint: ready.endpoint,
      serviceId: 'agent-runtime-smoke',
      sessionId: randomUUID(),
      teamId: randomUUID(),
      timeout: 5000,
      userId: 'local-user'
    })
    const written = await client.addConversation({
      messages: [
        { content: 'Preserve this conversation across service restart.', role: 'user' },
        { content: 'Recorded.', role: 'assistant' }
      ]
    })
    assert.equal(written.accepted_ids.length, 2)
    const before = await client.queryConversation()
    assert.equal(before.total, 2)
    assert.deepEqual(before.messages.map((message) => message.id).sort(), [...written.accepted_ids].sort())
    assert.deepEqual(
      before.messages.map((message) => message.content).sort(),
      ['Preserve this conversation across service restart.', 'Recorded.'].sort()
    )
    await service.stop()
    await service.stop()
    assert.equal((await service.status()).owned, false)
    await service.start()
    const after = await client.queryConversation()
    assert.deepEqual(after.messages, before.messages)
    console.log(
      JSON.stringify(
        {
          install: 'verified source',
          node: process.version,
          ownedStop: true,
          repeatInstall: true,
          repeatStart: true,
          restartMessages: after.total,
          status: 'PASS',
          version: ready.version
        },
        null,
        2
      )
    )
  } finally {
    await service.dispose()
    delete process.env[credentialEnv]
    if (!process.env.MEMORY_SERVICE_DIR) {
      await rm(directory, { force: true, recursive: true })
    }
  }
}
