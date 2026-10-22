// cspell:ignore addext keyout
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import { request } from 'node:http'
import { createServer } from 'node:https'
import { join } from 'node:path'

import { launchNitro } from '../../server/test/nitro.fixture.ts'

/** Local TLS termination with an ephemeral certificate; never changes system trust. */
export const launchHttpsNitro = async (directory: string, environment: NodeJS.ProcessEnv = {}) => {
  const key = join(directory, 'tls-key.pem')
  const certificate = join(directory, 'tls-cert.pem')
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=IP:127.0.0.1,DNS:localhost',
      '-keyout',
      key,
      '-out',
      certificate
    ],
    { stdio: 'ignore' }
  )
  let upstream: Awaited<ReturnType<typeof launchNitro>> | undefined
  const proxy = createServer({ cert: await readFile(certificate), key: await readFile(key) }, (incoming, outgoing) => {
    if (!upstream) {
      outgoing.writeHead(503).end()
      return
    }
    const forwarded = request(
      new URL(incoming.url ?? '/', upstream.url),
      { headers: incoming.headers, method: incoming.method },
      (response) => {
        outgoing.writeHead(response.statusCode ?? 502, response.headers)
        response.pipe(outgoing)
      }
    )
    forwarded.on('error', () => {
      if (!outgoing.headersSent) outgoing.writeHead(502)
      outgoing.end()
    })
    outgoing.on('close', () => forwarded.destroy())
    incoming.pipe(forwarded)
  })
  proxy.listen(0, '127.0.0.1')
  await once(proxy, 'listening')
  const address = proxy.address()
  assert(address && typeof address !== 'string')
  const url = `https://127.0.0.1:${address.port}`
  const close = async () => {
    proxy.closeAllConnections()
    await new Promise<void>((resolve) => proxy.close(() => resolve()))
    await upstream?.close()
  }
  try {
    upstream = await launchNitro(directory, { ...environment, RUNTIME_PUBLIC_ORIGIN: url })
    return { close, token: upstream.token, url }
  } catch (error) {
    await close()
    throw error
  }
}
