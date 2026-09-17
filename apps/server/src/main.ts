// biome-ignore-all lint/suspicious/noConsole: CLI status never includes the token.
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { Knowledge } from '@qingshaner/knowledge'
import { Mcp } from '@qingshaner/mcp'
import { MemoryCoreService, ProjectMemory } from '@qingshaner/memory'
import { ProjectResources } from '@qingshaner/runtime'
import { CodexRuntime } from '@qingshaner/runtime-codex'
import { Skills } from '@qingshaner/skill'

import { startServer } from './index.ts'

const dataDir = resolve(process.env.RUNTIME_DATA_DIR ?? '.agent-runtime')
await mkdir(dataDir, { recursive: true })
const mcp = await Mcp.open(join(dataDir, 'resources/mcp'))
const resources = new ProjectResources({
  knowledge: await Knowledge.open(join(dataDir, 'resources/knowledge')),
  mcp,
  skills: await Skills.open(join(dataDir, 'resources/skills'))
})
const endpoint =
  process.env.MEMORY_ENDPOINT ??
  (process.env.MEMORY_MODEL && process.env.MEMORY_BASE_URL ? 'http://127.0.0.1:8420' : undefined)
const serviceId = process.env.MEMORY_SERVICE_ID ?? 'agent-runtime'
const memory = endpoint ? new ProjectMemory({ apiKeyEnv: 'MEMORY_API_KEY', endpoint, serviceId }) : undefined
const memoryCore =
  process.env.MEMORY_MODEL && process.env.MEMORY_BASE_URL
    ? new MemoryCoreService({
        directory: join(dataDir, 'memory-core'),
        endpoint,
        gatewayApiKeyEnv: 'MEMORY_API_KEY',
        model: {
          apiKeyEnv: process.env.MEMORY_MODEL_API_KEY_ENV ?? 'DEEPSEEK_API_KEY',
          baseUrl: process.env.MEMORY_BASE_URL,
          name: process.env.MEMORY_MODEL
        },
        serviceId
      })
    : undefined
const server = await startServer({
  dataDir,
  memory,
  memoryCore,
  port: Number(process.env.PORT ?? 4310),
  resources,
  runtimes: [new CodexRuntime({ dataDir: join(dataDir, 'codex') })]
})
try {
  const temporary = join(dataDir, `http-token-${process.pid}`)
  try {
    await writeFile(temporary, server.token, { flag: 'wx', mode: 0o600 })
    await rename(temporary, join(dataDir, 'http-token'))
  } finally {
    await rm(temporary, { force: true })
  }
} catch (error) {
  await server.close()
  throw error
}
console.log(`Listening at ${server.url}; token stored in the data directory's http-token file`)
const stop = () => {
  void server
    .close()
    .finally(() => mcp.dispose())
    .catch(() => {
      process.exitCode = 1
    })
}
process.once('SIGINT', stop)
process.once('SIGTERM', stop)
