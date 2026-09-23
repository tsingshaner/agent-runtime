// biome-ignore-all lint/style/useNamingConvention: Process environment variables.
// biome-ignore-all lint/suspicious/noMisplacedAssertion: Standalone built-server smoke.
// biome-ignore-all lint/suspicious/noConsole: Smoke reports no credentials.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const directory = await mkdtemp(join(tmpdir(), 'nitro-smoke-'))
const reservation = createServer()
reservation.listen(0, '127.0.0.1')
await once(reservation, 'listening')
const address = reservation.address()
assert(address && typeof address !== 'string')
const port = address.port
await new Promise<void>((resolve) => reservation.close(() => resolve()))
const url = `http://127.0.0.1:${port}`
const launch = async () => {
  const child = spawn(process.execPath, ['.output/server/index.mjs'], {
    cwd: import.meta.dirname,
    env: {
      ...process.env,
      MEMORY_BASE_URL: '',
      MEMORY_ENDPOINT: '',
      MEMORY_MODEL: '',
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
  const stop = async () => {
    child.kill('SIGTERM')
    const timeout = setTimeout(() => child.kill('SIGKILL'), 10000)
    try {
      const [code] = await exited
      assert.equal(code, 0, output)
    } finally {
      clearTimeout(timeout)
    }
  }
  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (child.exitCode !== null) {
        throw new Error(`Nitro exited: ${output}`)
      }
      try {
        const token = await readFile(join(directory, 'http-token'), 'utf8')
        const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
        const response = await fetch(`${url}/health`, { headers, signal: AbortSignal.timeout(500) })
        if (response.ok) {
          return { headers, stop }
        }
      } catch {
        /* Listener and token file become ready independently. */
      }
      await delay(100)
    }
    throw new Error(`Nitro did not become ready: ${output}`)
  } catch (error) {
    await stop()
    throw error
  }
}
try {
  const first = await launch()
  try {
    assert.equal((await stat(join(directory, 'http-token'))).mode & 0o777, 0o600)
    assert.equal((await fetch(`${url}/spec.json`)).status, 401)
    assert.equal((await fetch(`${url}/spec.json`, { headers: first.headers })).status, 200)
    const created = await fetch(`${url}/projects`, {
      body: JSON.stringify({ id: 'nitro-smoke', name: 'Nitro smoke' }),
      headers: first.headers,
      method: 'POST'
    })
    assert.equal(created.status, 200, await created.text())
  } finally {
    await first.stop()
  }
  const second = await launch()
  try {
    assert.equal((await fetch(`${url}/health`, { headers: first.headers })).status, 401)
    const persisted = await fetch(`${url}/projects/nitro-smoke`, { headers: second.headers })
    assert.equal(persisted.status, 200)
    assert.match(await persisted.text(), /Nitro smoke/)
  } finally {
    await second.stop()
  }
  console.log(
    'VERIFIED: Nitro build, authenticated HTTP/OpenAPI, private token, shutdown and persistent restart; no model calls'
  )
} finally {
  await rm(directory, { force: true, recursive: true })
}
