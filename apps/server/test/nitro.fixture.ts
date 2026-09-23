// biome-ignore-all lint/style/useNamingConvention: Process environment variables.
// biome-ignore-all lint/suspicious/noMisplacedAssertion: Smoke process assertions.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

/** Launch the production Nitro build for HTTP smoke checks. */
export const launchNitro = async (directory: string, environment: NodeJS.ProcessEnv = {}) => {
  const reservation = createServer()
  reservation.listen(0, '127.0.0.1')
  await once(reservation, 'listening')
  const address = reservation.address()
  assert(address && typeof address !== 'string')
  const port = address.port
  await new Promise<void>((resolve) => reservation.close(() => resolve()))
  const url = `http://127.0.0.1:${port}`

  const child = spawn(process.execPath, ['.output/server/index.mjs'], {
    cwd: resolve(import.meta.dirname, '..'),
    env: {
      ...process.env,
      MEMORY_BASE_URL: '',
      MEMORY_ENDPOINT: '',
      MEMORY_MODEL: '',
      ...environment,
      NITRO_HOST: '127.0.0.1',
      NITRO_PORT: String(port),
      RUNTIME_DATA_DIR: directory
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let output = ''
  child.stdout.on('data', (chunk) => {
    output += String(chunk)
  })
  child.stderr.on('data', (chunk) => {
    output += String(chunk)
  })
  const exited = once(child, 'exit')
  let closing: Promise<void> | undefined
  const close = () =>
    (closing ??= (async () => {
      child.kill('SIGTERM')
      const timeout = setTimeout(() => child.kill('SIGKILL'), 10000)
      try {
        const [code] = await exited
        assert.equal(code, 0, output)
      } finally {
        clearTimeout(timeout)
      }
    })())
  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`Nitro exited: ${output}`)
      }
      try {
        const token = await readFile(join(directory, 'http-token'), 'utf8')
        const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
        const response = await fetch(`${url}/health`, { headers, signal: AbortSignal.timeout(500) })
        if (response.ok) {
          return { close, headers, token, url }
        }
      } catch {
        /* Listener and token file become ready independently. */
      }
      await delay(100)
    }
    throw new Error(`Nitro did not become ready: ${output}`)
  } catch (error) {
    await close()
    throw error
  }
}
