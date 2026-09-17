import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test } from 'vitest'

import { MemoryCoreService } from '../src/index'

test('construction does not install or start; start refuses missing installation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'memory-service-'))
  const service = new MemoryCoreService({
    directory,
    gatewayApiKeyEnv: 'MEMORY_TEST_TOKEN',
    model: { apiKeyEnv: 'MEMORY_TEST_MODEL_KEY', baseUrl: 'http://127.0.0.1:1/v1', name: 'explicit-model' },
    serviceId: 'test-service'
  })
  try {
    expect(await readdir(directory)).toEqual([])
    expect(await service.status()).toMatchObject({ owned: false, phase: 'not_installed' })
    await expect(service.start()).rejects.toMatchObject({ code: 'NOT_INSTALLED' })
    expect(await service.status()).toMatchObject({ error: { code: 'NOT_INSTALLED' }, owned: false, phase: 'failed' })
    await service.stop()
    await service.stop()
  } finally {
    await service.dispose()
    await rm(directory, { force: true, recursive: true })
  }
})

test('install rejects an unverified archive without touching persistent data and releases ownership', async () => {
  const { mkdir, writeFile, readFile } = await import('node:fs/promises')
  const directory = await mkdtemp(join(tmpdir(), 'memory-install-'))
  const archive = join(directory, 'wrong.tar.gz')
  await writeFile(archive, 'not the pinned release')
  await mkdir(join(directory, 'data'))
  await writeFile(join(directory, 'data', 'keep'), 'existing memory')
  const service = new MemoryCoreService({
    directory,
    gatewayApiKeyEnv: 'MEMORY_TEST_TOKEN',
    model: { apiKeyEnv: 'MEMORY_TEST_MODEL_KEY', baseUrl: 'http://127.0.0.1:1/v1', name: 'explicit-model' },
    serviceId: 'test-service'
  })
  try {
    await expect(service.install({ archivePath: archive })).rejects.toMatchObject({ code: 'ARCHIVE_INTEGRITY' })
    await expect(service.install({ archivePath: archive })).rejects.toMatchObject({ code: 'ARCHIVE_INTEGRITY' })
    expect(await readFile(join(directory, 'data', 'keep'), 'utf8')).toBe('existing memory')
    expect(await service.status()).toMatchObject({ error: { code: 'ARCHIVE_INTEGRITY' }, phase: 'failed' })
  } finally {
    await service.dispose()
    await rm(directory, { force: true, recursive: true })
  }
})

test('owns one healthy process, repeats start/stop safely and preserves data across restart', async () => {
  const { fixture } = await import('./fixture')
  const options = await fixture()
  const service = new MemoryCoreService(options)
  process.env.MEMORY_TEST_TOKEN = 'fixture-gateway-secret'
  process.env.MEMORY_TEST_MODEL_KEY = 'fixture-model-secret'
  try {
    const [first, second] = await Promise.all([service.start(), service.start()])
    expect(first).toMatchObject({ owned: true, phase: 'running' })
    expect(second).toEqual(first)
    const url = `${options.endpoint}/data`
    const headers = { authorization: 'Bearer fixture-gateway-secret' }
    expect((await fetch(url, { body: 'persistent memory', headers, method: 'PUT' })).ok).toBe(true)
    await service.stop()
    await service.stop()
    expect(await service.status()).toMatchObject({ owned: false, phase: 'stopped' })
    await service.start()
    expect(await (await fetch(url, { headers })).text()).toBe('persistent memory')
    expect(JSON.stringify(await service.status())).not.toContain('fixture-gateway-secret')
    await service.dispose()
    await expect(service.start()).rejects.toMatchObject({ code: 'DISPOSED' })
  } finally {
    await service.dispose()
    delete process.env.MEMORY_TEST_TOKEN
    delete process.env.MEMORY_TEST_MODEL_KEY
    await rm(options.directory, { force: true, recursive: true })
  }
})

test('a different owner cannot start or stop a service, including an occupied endpoint', async () => {
  const { fixture } = await import('./fixture')
  const a = await fixture()
  const b = await fixture()
  const first = new MemoryCoreService(a)
  const sameDirectory = new MemoryCoreService(a)
  const samePort = new MemoryCoreService({ ...b, endpoint: a.endpoint })
  process.env.MEMORY_TEST_TOKEN = 'fixture-gateway-secret'
  process.env.MEMORY_TEST_MODEL_KEY = 'fixture-model-secret'
  try {
    await first.start()
    await expect(sameDirectory.start()).rejects.toMatchObject({ code: 'BUSY' })
    await sameDirectory.stop()
    await expect(samePort.start()).rejects.toMatchObject({ code: 'PROCESS_EXITED' })
    await samePort.stop()
    expect((await fetch(`${a.endpoint}/health`)).ok).toBe(true)
    expect(await first.status()).toMatchObject({ owned: true, phase: 'running' })
  } finally {
    await Promise.all([first.dispose(), sameDirectory.dispose(), samePort.dispose()])
    delete process.env.MEMORY_TEST_TOKEN
    delete process.env.MEMORY_TEST_MODEL_KEY
    await Promise.all([
      rm(a.directory, { force: true, recursive: true }),
      rm(b.directory, { force: true, recursive: true })
    ])
  }
})

test('failed health retains a safe diagnostic and releases the owned process and lock', async () => {
  const { fixture } = await import('./fixture')
  const options = await fixture('unhealthy')
  const service = new MemoryCoreService({ ...options, startupTimeoutMs: 200 })
  process.env.MEMORY_TEST_TOKEN = 'fixture-gateway-secret'
  process.env.MEMORY_TEST_MODEL_KEY = 'fixture-model-secret'
  try {
    await expect(service.start()).rejects.toMatchObject({ code: 'HEALTH_TIMEOUT' })
    expect(await service.status()).toMatchObject({ error: { code: 'HEALTH_TIMEOUT' }, owned: false, phase: 'failed' })
    await expect(fetch(`${options.endpoint}/health`)).rejects.toThrow()
    await expect(service.start()).rejects.toMatchObject({ code: 'HEALTH_TIMEOUT' })
  } finally {
    await service.dispose()
    delete process.env.MEMORY_TEST_TOKEN
    delete process.env.MEMORY_TEST_MODEL_KEY
    await rm(options.directory, { force: true, recursive: true })
  }
})

test('shutdown escalates only its owned child when the process ignores termination', async () => {
  const { fixture } = await import('./fixture')
  const options = await fixture('ignore-term')
  const service = new MemoryCoreService(options)
  process.env.MEMORY_TEST_TOKEN = 'fixture-gateway-secret'
  process.env.MEMORY_TEST_MODEL_KEY = 'fixture-model-secret'
  try {
    await service.start()
    await service.dispose()
    expect(await service.status()).toMatchObject({ owned: false, phase: 'stopped' })
    await expect(fetch(`${options.endpoint}/health`)).rejects.toThrow()
  } finally {
    await service.dispose()
    delete process.env.MEMORY_TEST_TOKEN
    delete process.env.MEMORY_TEST_MODEL_KEY
    await rm(options.directory, { force: true, recursive: true })
  }
})

test.each(['../other-service', '', 'service/name'])('rejects unsafe service identity %s', (serviceId) => {
  expect(
    () =>
      new MemoryCoreService({
        directory: '/tmp/memory-not-created',
        gatewayApiKeyEnv: 'MEMORY_TEST_TOKEN',
        model: { apiKeyEnv: 'MEMORY_TEST_MODEL_KEY', baseUrl: 'https://api.deepseek.com', name: 'explicit' },
        serviceId
      })
  ).toThrowError('Invalid MemoryCore')
})

test('can query startup failure when installation metadata is corrupt', async () => {
  const { fixture } = await import('./fixture')
  const { writeFile } = await import('node:fs/promises')
  const { MEMORY_CORE_COMMIT } = await import('../src/index')
  const options = await fixture()
  await writeFile(join(options.directory, 'versions', MEMORY_CORE_COMMIT, 'installed.json'), 'private-invalid-metadata')
  const service = new MemoryCoreService(options)
  try {
    await expect(service.start()).rejects.toMatchObject({ code: 'IO_ERROR' })
    const status = await service.status()
    expect(status).toMatchObject({ error: { code: 'IO_ERROR' }, owned: false, phase: 'failed' })
    expect(JSON.stringify(status)).not.toContain('private-invalid-metadata')
  } finally {
    await service.dispose()
    await rm(options.directory, { force: true, recursive: true })
  }
})
