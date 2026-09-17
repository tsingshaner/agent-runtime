// biome-ignore-all lint/suspicious/noConsole: CLI status never includes the token.
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { CodexRuntime } from '@qingshaner/runtime-codex'

import { startServer } from './index.ts'

const dataDir = resolve(process.env.RUNTIME_DATA_DIR ?? '.agent-runtime')
await mkdir(dataDir, { recursive: true })
const server = await startServer({
  dataDir,
  port: Number(process.env.PORT ?? 4310),
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
  void server.close().catch(() => {
    process.exitCode = 1
  })
}
process.once('SIGINT', stop)
process.once('SIGTERM', stop)
