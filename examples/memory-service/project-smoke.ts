// biome-ignore-all lint/suspicious/noConsole: Explicit real smoke report.
// biome-ignore-all lint/suspicious/noMisplacedAssertion: Standalone smoke assertions.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'

import { MemoryCoreService, ProjectMemory } from '@qingshaner/memory'

if (process.env.RUN_PROJECT_MEMORY_SMOKE !== '1') {
  console.log('SKIPPED: set RUN_PROJECT_MEMORY_SMOKE=1 for real project memory smoke')
} else {
  const { MEMORY_SERVICE_DIR: directory, MEMORY_MODEL: model, DEEPSEEK_BASE_URL: baseUrl } = process.env
  assert(directory && model && baseUrl, 'Set MEMORY_SERVICE_DIR, MEMORY_MODEL and DEEPSEEK_BASE_URL')
  const tokenName = `MEMORY_SMOKE_${randomUUID().replaceAll('-', '')}`
  process.env[tokenName] = randomUUID()
  const service = new MemoryCoreService({
    directory,
    endpoint: 'http://127.0.0.1:18425',
    gatewayApiKeyEnv: tokenName,
    model: { apiKeyEnv: 'DEEPSEEK_API_KEY', baseUrl, name: model },
    serviceId: 'project-memory-smoke'
  })
  try {
    const status = await service.start()
    const memory = new ProjectMemory({
      apiKeyEnv: tokenName,
      endpoint: status.endpoint,
      serviceId: 'project-memory-smoke'
    })
    const projectId = randomUUID()
    const other = randomUUID()
    const receipt = await memory.write({
      assistant: 'Your Cobalt project preferences are TypeScript, arrow functions, pnpm and Node.js 24.',
      projectId,
      runId: randomUUID(),
      sessionId: randomUUID(),
      user: 'For my personal Cobalt project I strongly prefer TypeScript and arrow functions. I use pnpm and Node.js 24 every day. Remember these durable development preferences.'
    })
    assert.equal(receipt.status, 'accepted')
    assert.equal((await memory.conversations(projectId)).total, 2)
    assert.equal((await memory.conversations(other)).total, 0)
    let records = (await memory.query(projectId)).items
    const deadline = Date.now() + 90000
    while (records.length === 0 && Date.now() < deadline) {
      await delay(1000)
      records = (await memory.query(projectId)).items
    }
    const first = records[0]
    if (!first) {
      console.log('UNVERIFIED: conversation isolation passed; L1 extraction did not trigger, update/delete unavailable')
      process.exitCode = 1
    } else {
      const recalled = await memory.recall(projectId, 'TypeScript')
      assert.ok(recalled.context.length > 0)
      assert.equal((await memory.recall(other, 'TypeScript')).context, '')
      await memory.update(projectId, first.id, 'Cobalt project now prefers concise TypeScript arrow functions.')
      assert.equal(
        (await memory.query(projectId)).items.find(({ id }) => id === first.id)?.content,
        'Cobalt project now prefers concise TypeScript arrow functions.'
      )
      await memory.delete(projectId, [first.id])
      assert.ok(!(await memory.query(projectId)).items.some(({ id }) => id === first.id))
      assert.equal((await memory.query(other)).items.length, 0)
      console.log(
        'VERIFIED: fixed Core/SDK writes, L0/L1 project isolation, generated recall, atomic memory update and delete'
      )
    }
  } finally {
    await service.dispose()
    delete process.env[tokenName]
  }
}
