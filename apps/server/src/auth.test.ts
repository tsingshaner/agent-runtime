import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test, vi } from 'vitest'

import { ManualAdapter } from '../../../packages/runtime/test/manual-adapter'
import { setupMemoryDatabase } from '../../../packages/runtime/test/memory-database.fixture'
import { openTestService } from '../test/service.fixture'

setupMemoryDatabase()

describe('browser authentication over HTTP', () => {
  test('exchanges a token for a browser session and revokes it on logout', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'web-auth-'))
    const server = await openTestService({ dataDir: directory, runtimes: [new ManualAdapter()] })
    try {
      const login = await server.fetch(`${server.url}/auth/sign-in/token`, {
        body: JSON.stringify({ token: server.token }),
        headers: { 'content-type': 'application/json', origin: server.url },
        method: 'POST'
      })
      expect(login.status).toBe(200)
      const setCookie = login.headers.get('set-cookie') ?? ''
      expect(setCookie).toContain('HttpOnly')
      expect(setCookie).toContain('SameSite=Strict')
      expect(setCookie).toContain('Max-Age=604800')
      expect(setCookie).not.toContain(server.token)
      expect(await login.json()).toEqual({ authenticated: true })
      const cookie = setCookie.split(';')[0] ?? ''
      expect((await server.fetch(`${server.url}/health`, { headers: { cookie } })).status).toBe(200)
      expect((await server.fetch(`${server.url}/auth/get-session`, { headers: { cookie } })).status).toBe(200)
      const logout = await server.fetch(`${server.url}/auth/sign-out`, {
        headers: { cookie, origin: server.url },
        method: 'POST'
      })
      expect(logout.status).toBe(200)
      expect(logout.headers.get('set-cookie')).toContain('Max-Age=0')
      expect((await server.fetch(`${server.url}/health`, { headers: { cookie } })).status).toBe(401)
      expect(
        (
          await server.fetch(`${server.url}/health`, {
            headers: { authorization: `Bearer ${server.token}` }
          })
        ).status
      ).toBe(200)
    } finally {
      await server.close()
      await rm(directory, { force: true, recursive: true })
    }
  }, 20000)
  test('rejects a cookie from another origin even when that origin may use bearer authentication', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'web-origin-'))
    const server = await openTestService({
      dataDir: directory,
      origins: ['https://client.example'],
      runtimes: [new ManualAdapter()]
    })
    try {
      const login = await server.fetch(`${server.url}/auth/sign-in/token`, {
        body: JSON.stringify({ token: server.token }),
        headers: { 'content-type': 'application/json', origin: server.url },
        method: 'POST'
      })
      const cookie = login.headers.get('set-cookie')?.split(';')[0] ?? ''
      const response = await server.fetch(`${server.url}/health`, {
        headers: { cookie, origin: 'https://client.example' }
      })
      expect(response.status).toBe(403)
    } finally {
      await server.close()
      await rm(directory, { force: true, recursive: true })
    }
  }, 20000)

  test('expires a browser session after seven days and invalidates it on server restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'web-expiry-'))
    const server = await openTestService({ dataDir: directory, runtimes: [new ManualAdapter()] })
    try {
      const login = async () => {
        const response = await server.fetch(`${server.url}/auth/sign-in/token`, {
          body: JSON.stringify({ token: server.token }),
          headers: { 'content-type': 'application/json', origin: server.url },
          method: 'POST'
        })
        expect(response.status).toBe(200)
        return response.headers.get('set-cookie')?.split(';')[0] ?? ''
      }
      const cookie = await login()
      const now = Date.now()
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(now + 7 * 24 * 60 * 60 * 1000)
      try {
        expect((await server.fetch(`${server.url}/health`, { headers: { cookie } })).status).toBe(401)
      } finally {
        vi.useRealTimers()
      }
      const renewed = await login()
      await server.close()
      const restarted = await openTestService({ dataDir: directory, runtimes: [new ManualAdapter()] })
      expect((await restarted.fetch(`${restarted.url}/health`, { headers: { cookie: renewed } })).status).toBe(401)
      expect(
        (
          await restarted.fetch(`${restarted.url}/health`, {
            headers: { authorization: `Bearer ${server.token}` }
          })
        ).status
      ).toBe(401)
      await restarted.close()
    } finally {
      await server.close()
      await rm(directory, { force: true, recursive: true })
    }
  }, 20000)

  test('protects cookie writes and event subscriptions at the configured HTTPS origin', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'web-https-'))
    const server = await openTestService({
      dataDir: directory,
      origin: 'https://agent.example',
      runtimes: [new ManualAdapter()]
    })
    try {
      const send = (token: unknown, origin: string = server.url) =>
        server.fetch(`${server.url}/auth/sign-in/token`, {
          body: JSON.stringify({ token }),
          headers: { 'content-type': 'application/json', origin },
          method: 'POST'
        })
      expect((await send(server.token, 'https://evil.example')).status).toBe(403)
      const invalid = await send('do-not-echo')
      expect(invalid.status).toBe(401)
      expect(await invalid.text()).not.toContain('do-not-echo')
      expect((await send({ secret: 'do-not-echo' })).status).toBe(400)
      const login = await send(server.token)
      expect(login.headers.get('set-cookie')).toContain('; Secure')
      const cookie = login.headers.get('set-cookie')?.split(';')[0] ?? ''
      for (const headers of [
        { cookie },
        { cookie, origin: 'null' },
        { cookie, origin: 'https://evil.example' },
        { cookie, host: 'evil.example', origin: server.url, 'x-forwarded-host': 'agent.example' }
      ]) {
        const response = await server.fetch(`${server.url}/projects`, {
          body: JSON.stringify({ name: 'forged' }),
          headers: { ...headers, 'content-type': 'application/json' },
          method: 'POST'
        })
        expect(response.status).toBe(403)
      }
      expect(
        (
          await server.fetch(`${server.url}/projects`, {
            body: JSON.stringify({ name: 'browser' }),
            headers: { 'content-type': 'application/json', cookie, origin: server.url },
            method: 'POST'
          })
        ).status
      ).toBe(200)
      expect((await server.fetch(`${server.url}/runs/missing/events`)).status).toBe(401)
      expect(
        (await server.fetch(`${server.url}/health`, { headers: { authorization: 'Bearer wrong', cookie } })).status
      ).toBe(401)
    } finally {
      await server.close()
      await rm(directory, { force: true, recursive: true })
    }
  }, 20000)

  test.each(['ftp://agent.example', 'https://user:secret@agent.example', 'https://agent.example/path'])(
    'rejects unsafe public origin %s before opening the runtime',
    async (origin) => {
      await expect(openTestService({ dataDir: '/unused-origin-test', origin, runtimes: [] })).rejects.toThrow(
        'Invalid public origin'
      )
    }
  )
  test('rejects new browser logins after service shutdown', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'web-closed-'))
    const server = await openTestService({ dataDir: directory, runtimes: [new ManualAdapter()] })
    try {
      await server.close()
      const response = await server.fetch(`${server.url}/auth/sign-in/token`, {
        body: JSON.stringify({ token: server.token }),
        headers: { 'content-type': 'application/json', origin: server.url },
        method: 'POST'
      })
      expect(response.status).toBe(503)
      expect(response.headers.get('set-cookie')).toBeNull()
    } finally {
      await server.close()
      await rm(directory, { force: true, recursive: true })
    }
  }, 20000)
})
