// biome-ignore-all lint/suspicious/noMisplacedAssertion: Standalone built-server smoke.
// biome-ignore-all lint/suspicious/noConsole: Smoke reports no credentials.
import assert from 'node:assert/strict'
import { access, mkdtemp, rm, stat } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { launchNitro } from './test/nitro.fixture.ts'

const directory = await mkdtemp(join(tmpdir(), 'nitro-smoke-'))

try {
  const first = await launchNitro(directory)
  try {
    assert.equal((await stat(join(directory, 'http-token'))).mode & 0o777, 0o600)
    assert.equal((await fetch(`${first.url}/spec.json`)).status, 401)
    assert.equal((await fetch(`${first.url}/openapi.html`, { headers: first.headers })).status, 404)
    assert.equal((await fetch(`${first.url}/spec.json`, { headers: first.headers })).status, 200)
    assert.equal(
      (await fetch(`${first.url}/health`, { headers: { ...first.headers, origin: 'https://evil.example' } })).status,
      403
    )
    const wrongHost = await new Promise<number | undefined>((resolve, reject) => {
      const request = httpRequest(
        `${first.url}/health`,
        { headers: { ...first.headers, host: 'evil.example' } },
        (response) => {
          response.resume()
          resolve(response.statusCode)
        }
      )
      request.on('error', reject).end()
    })
    assert.equal(wrongHost, 403)
    for (const [body, status] of [
      ['{bad', 400],
      [JSON.stringify({ name: 'a'.repeat(1024 * 1024) }), 413]
    ] as const) {
      const response = await fetch(`${first.url}/projects`, { body, headers: first.headers, method: 'POST' })
      assert.equal(response.status, status)
      await response.body?.cancel()
    }
    const created = await fetch(`${first.url}/projects`, {
      body: JSON.stringify({ id: 'nitro-smoke', name: 'Nitro smoke' }),
      headers: first.headers,
      method: 'POST'
    })
    assert.equal(created.status, 200, await created.text())
  } finally {
    await first.close()
  }
  await assert.rejects(fetch(`${first.url}/health`))
  const second = await launchNitro(directory)
  try {
    assert.equal((await fetch(`${second.url}/health`, { headers: first.headers })).status, 401)
    const persisted = await fetch(`${second.url}/projects/nitro-smoke`, { headers: second.headers })
    assert.equal(persisted.status, 200)
    assert.match(await persisted.text(), /Nitro smoke/)
  } finally {
    await second.close()
  }
  const dev = await launchNitro(directory, {}, true)
  try {
    const docs = await fetch(`${dev.url}/openapi.html`)
    assert.equal(docs.status, 200)
    assert.match(docs.headers.get('content-type') ?? '', /text\/html/)
    const html = await docs.text()
    assert.match(html, /@scalar\/api-reference/)
    assert.match(html, /url: '\/spec.json'/)
    assert(!html.includes(dev.token))
    const response = await fetch(`${dev.url}/spec.json`)
    assert.equal(response.status, 200)
    assert.match(await response.text(), /subscribeRunEvents/)
    assert.equal((await fetch(`${dev.url}/health`)).status, 401)
    assert.equal((await fetch(`${dev.url}/spec.json`, { method: 'POST' })).status, 401)
  } finally {
    await dev.close()
  }
  await assert.rejects(access(join(directory, '.manager.lock')), { code: 'ENOENT' })
  const restartedDev = await launchNitro(directory, {}, true)
  await restartedDev.close('SIGINT')
  await assert.rejects(access(join(directory, '.manager.lock')), { code: 'ENOENT' })
  console.log(
    'VERIFIED: Nitro build, public dev spec, authenticated production HTTP/OpenAPI, private token, shutdown and persistent restart; no model calls'
  )
} finally {
  await rm(directory, { force: true, recursive: true })
}
