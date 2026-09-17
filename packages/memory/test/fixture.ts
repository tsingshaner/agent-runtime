import { copyFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { MEMORY_CORE_COMMIT, MEMORY_CORE_VERSION, type MemoryCoreOptions } from '../src/index'

export const fixture = async (model = 'fixture'): Promise<MemoryCoreOptions> => {
  const directory = await mkdtemp(join(tmpdir(), 'memory-service-'))
  const core = join(directory, 'versions', MEMORY_CORE_COMMIT)
  await mkdir(join(core, 'src/gateway'), { recursive: true })
  await mkdir(join(core, 'node_modules/tsx'), { recursive: true })
  await writeFile(
    join(core, 'installed.json'),
    JSON.stringify({ commit: MEMORY_CORE_COMMIT, version: MEMORY_CORE_VERSION })
  )
  await writeFile(join(core, 'package.json'), JSON.stringify({ type: 'module', version: MEMORY_CORE_VERSION }))
  await writeFile(join(core, 'node_modules/tsx/package.json'), '{"type":"module","exports":"./index.js"}')
  await writeFile(join(core, 'node_modules/tsx/index.js'), 'export {}')
  await copyFile(join(import.meta.dirname, 'gateway.fixture.ts'), join(core, 'src/gateway/server.ts'))
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Missing address')
  }
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return {
    directory,
    endpoint: `http://127.0.0.1:${address.port}`,
    gatewayApiKeyEnv: 'MEMORY_TEST_TOKEN',
    model: { apiKeyEnv: 'MEMORY_TEST_MODEL_KEY', baseUrl: 'http://127.0.0.1:1/v1', name: model },
    serviceId: 'test-service',
    shutdownTimeoutMs: 100,
    startupTimeoutMs: 2000
  }
}
