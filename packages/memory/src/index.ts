// cspell:ignore TDAI memorycore
// biome-ignore-all lint/style/useNamingConvention: Upstream environment variable names.
import { type ChildProcess, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

export const MEMORY_CORE_VERSION = '1.0.2-beta.1'
const ARCHIVE_SHA256 = 'bbe69042f1d58ffdace3169427d9714b7d6b87071a220279ca181a763e00e186'
export const MEMORY_CORE_COMMIT = '8f2dc830317934e54548472bf62c5999f9bb1202'

export interface MemoryCoreOptions {
  directory: string
  endpoint?: string
  gatewayApiKeyEnv: string
  serviceId: string
  model: { name: string; baseUrl: string; apiKeyEnv: string }
  startupTimeoutMs?: number
  shutdownTimeoutMs?: number
}
export interface MemoryCoreStatus {
  phase: 'not_installed' | 'stopped' | 'starting' | 'running' | 'failed'
  owned: boolean
  endpoint: string
  version: string
  error?: { code: string; message: string }
}
export class MemoryCoreError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'MemoryCoreError'
  }
}

/** Owns only processes started by this instance; construction has no side effects. */
export class MemoryCoreService {
  readonly #options: MemoryCoreOptions
  readonly #endpoint: string
  #child?: ChildProcess
  #exited?: Promise<void>
  #release?: () => Promise<void>
  #phase: MemoryCoreStatus['phase'] = 'stopped'
  #queue: Promise<unknown> = Promise.resolve()
  #disposed = false
  #failure?: MemoryCoreStatus['error']

  constructor(options: MemoryCoreOptions) {
    if (!isAbsolute(options.directory)) {
      throw new MemoryCoreError('INVALID_CONFIG', 'directory must be absolute')
    }
    validateOptions(options)
    this.#options = structuredClone(options)
    this.#endpoint = new URL(options.endpoint ?? 'http://127.0.0.1:8420').origin
  }

  async status(): Promise<MemoryCoreStatus> {
    const installed = !this.#failure && (await this.#installed())
    const owned = !!this.#child && this.#child.exitCode === null && this.#child.signalCode === null
    return {
      endpoint: this.#endpoint,
      owned,
      phase: this.#failure ? 'failed' : owned ? this.#phase : installed ? 'stopped' : 'not_installed',
      version: MEMORY_CORE_VERSION,
      ...(this.#failure ? { error: { ...this.#failure } } : {})
    }
  }

  /** Install the verified fixed source into a version directory; never touches data. */
  install(options: { archivePath?: string } = {}): Promise<MemoryCoreStatus> {
    return this.#exclusive(async () => {
      if (await this.#installed()) {
        return this.status()
      }
      const release = await this.#acquire()
      let staging: string | undefined
      try {
        const target = join(this.#options.directory, 'versions', MEMORY_CORE_COMMIT)
        if (await exists(join(target, 'installed.json'))) {
          return this.status()
        }
        staging = await mkdtemp(join(this.#options.directory, '.install-'))
        const archive = options.archivePath ? await readFile(options.archivePath) : await downloadArchive()
        if (createHash('sha256').update(archive).digest('hex') !== ARCHIVE_SHA256) {
          throw new MemoryCoreError('ARCHIVE_INTEGRITY', 'Archive does not match the pinned MemoryCore SHA-256')
        }
        const archivePath = join(staging, 'source.tar.gz')
        await writeFile(archivePath, archive, { mode: 0o600 })
        await command('tar', ['-xzf', archivePath, '-C', staging, '--strip-components=1'], staging)
        const core = join(staging, 'MemoryCore')
        const manifest = JSON.parse(await readFile(join(core, 'package.json'), 'utf8'))
        if (manifest.version !== MEMORY_CORE_VERSION) {
          throw new MemoryCoreError('INSTALL_INVALID', 'Core version mismatch')
        }
        await command(
          'npm',
          [
            'install',
            '--ignore-scripts',
            '--omit=dev',
            '--no-audit',
            '--no-fund',
            '--registry=https://registry.npmjs.org'
          ],
          core
        )
        await writeFile(
          join(core, 'installed.json'),
          JSON.stringify({ commit: MEMORY_CORE_COMMIT, version: MEMORY_CORE_VERSION }),
          { mode: 0o600 }
        )
        await mkdir(join(this.#options.directory, 'versions'), { recursive: true })
        await rename(core, target)
        this.#failure = undefined
        return this.status()
      } finally {
        try {
          if (staging) {
            await rm(staging, { force: true, recursive: true })
          }
        } finally {
          await release()
        }
      }
    })
  }

  /** Start only an installed Core; readiness requires this child's listen signal and health. */
  start(): Promise<MemoryCoreStatus> {
    return this.#exclusive(async () => {
      if (this.#child && this.#child.exitCode === null && this.#child.signalCode === null) {
        return this.status()
      }
      await this.#shutdown()
      if (!(await this.#installed())) {
        throw new MemoryCoreError('NOT_INSTALLED', 'Install the fixed MemoryCore before starting')
      }
      const modelKey = credential(this.#options.model.apiKeyEnv)
      const apiKey = credential(this.#options.gatewayApiKeyEnv)
      this.#release = await this.#acquire()
      this.#failure = undefined
      this.#phase = 'starting'
      try {
        const endpoint = new URL(this.#endpoint)
        const config = {
          data: { baseDir: join(this.#options.directory, 'data') },
          deployMode: 'standalone',
          instanceId: this.#options.serviceId,
          llm: { apiKey: modelKey, baseUrl: this.#options.model.baseUrl, model: this.#options.model.name },
          memory: {
            bm25: { enabled: true },
            embedding: { provider: 'none' },
            extraction: { enabled: true },
            recall: { enabled: true },
            storeBackend: 'sqlite'
          },
          server: { apiKey, host: endpoint.hostname.replace(/^\[|\]$/g, ''), port: Number(endpoint.port || 80) },
          stateBackend: 'local'
        }
        await mkdir(config.data.baseDir, { mode: 0o700, recursive: true })
        const configPath = join(this.#options.directory, '.memorycore.lock', 'gateway.json')
        await writeFile(configPath, JSON.stringify(config), { flag: 'wx', mode: 0o600 })
        const child = spawn(process.execPath, ['--import', 'tsx', 'src/gateway/server.ts'], {
          cwd: join(this.#options.directory, 'versions', MEMORY_CORE_COMMIT),
          env: {
            HOME: this.#options.directory,
            PATH: process.env.PATH,
            TDAI_GATEWAY_CONFIG: configPath,
            TDAI_OTEL_ENABLED: 'false'
          },
          stdio: ['ignore', 'pipe', 'pipe']
        })
        this.#child = child
        let listening = false
        let tail = ''
        child.stdout?.on('data', (chunk: Buffer) => {
          tail = (tail + chunk.toString()).slice(-2048)
          listening ||= tail.includes('Gateway listening on')
        })
        child.stderr?.resume()
        child.on('error', () => {})
        this.#exited = new Promise<void>((resolve) => {
          child.once('close', (code, signal) => {
            if (this.#phase !== 'stopped') {
              this.#failure = { code: 'PROCESS_EXITED', message: `MemoryCore exited (code ${code}, signal ${signal})` }
              this.#phase = 'failed'
            }
            resolve()
          })
        })
        await this.#waitForHealth(child, () => listening)
        this.#phase = 'running'
        return this.status()
      } catch (error) {
        await this.#shutdown()
        throw error
      }
    })
  }

  /** Stop only the retained child handle; never adopts or kills a PID from disk. */
  stop(): Promise<void> {
    const next = this.#queue.then(() => this.#shutdown())
    this.#queue = next.catch(() => {})
    return next
  }

  /** Reject new work and wait for bounded owned-process shutdown. Safe to repeat. */
  async dispose(): Promise<void> {
    this.#disposed = true
    await this.stop()
  }

  async #waitForHealth(child: ChildProcess, listening: () => boolean): Promise<void> {
    const deadline = Date.now() + (this.#options.startupTimeoutMs ?? 30_000)
    while (Date.now() < deadline) {
      if (this.#failure) {
        throw new MemoryCoreError(this.#failure.code, this.#failure.message)
      }
      if (listening()) {
        const response = await fetch(`${this.#endpoint}/health`, {
          signal: AbortSignal.timeout(Math.max(1, Math.min(500, deadline - Date.now())))
        }).catch(() => undefined)
        await response?.body?.cancel()
        if (response?.ok && child.exitCode === null && child.signalCode === null) {
          return
        }
      }
      await delay(50)
    }
    throw new MemoryCoreError('HEALTH_TIMEOUT', 'Owned MemoryCore did not become healthy before the startup deadline')
  }

  async #shutdown(): Promise<void> {
    this.#phase = 'stopped'
    const child = this.#child
    if (child) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM')
        const timer = setTimeout(() => child.kill('SIGKILL'), this.#options.shutdownTimeoutMs ?? 5000)
        try {
          await this.#exited
        } finally {
          clearTimeout(timer)
        }
      } else {
        await this.#exited
      }
      this.#child = undefined
      this.#exited = undefined
    }
    await this.#release?.()
    this.#release = undefined
  }

  async #installed(): Promise<boolean> {
    const core = join(this.#options.directory, 'versions', MEMORY_CORE_COMMIT)
    if (!(await exists(join(core, 'installed.json')))) {
      return false
    }
    const metadata = JSON.parse(await readFile(join(core, 'installed.json'), 'utf8'))
    const manifest = JSON.parse(await readFile(join(core, 'package.json'), 'utf8'))
    if (
      metadata.commit !== MEMORY_CORE_COMMIT ||
      metadata.version !== MEMORY_CORE_VERSION ||
      manifest.version !== MEMORY_CORE_VERSION
    ) {
      throw new MemoryCoreError('INSTALL_INVALID', 'Installed MemoryCore does not match the fixed release')
    }
    await access(join(core, 'src/gateway/server.ts'))
    await access(join(core, 'node_modules/tsx/package.json'))
    return true
  }

  #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(async () => {
      if (this.#disposed) {
        throw new MemoryCoreError('DISPOSED', 'MemoryCore service is disposed')
      }
      try {
        return await operation()
      } catch (error) {
        const safe =
          error instanceof MemoryCoreError
            ? error
            : new MemoryCoreError('IO_ERROR', 'MemoryCore filesystem or process operation failed')
        this.#failure = { code: safe.code, message: safe.message }
        throw safe
      }
    })
    this.#queue = next.catch(() => {})
    return next
  }

  async #acquire(): Promise<() => Promise<void>> {
    await mkdir(this.#options.directory, { mode: 0o700, recursive: true })
    const lock = join(await realpath(this.#options.directory), '.memorycore.lock')
    try {
      await mkdir(lock, { mode: 0o700 })
    } catch {
      throw new MemoryCoreError(
        'BUSY',
        'MemoryCore directory has an owner; stale locks require explicit manual recovery'
      )
    }
    const token = randomUUID()
    try {
      await writeFile(join(lock, 'owner.json'), JSON.stringify({ token }), { flag: 'wx', mode: 0o600 })
    } catch (error) {
      await rm(lock, { recursive: true })
      throw error
    }
    let released = false
    return async () => {
      if (released) {
        return
      }
      const owner = await readFile(join(lock, 'owner.json'), 'utf8').catch(() => '')
      if (owner !== JSON.stringify({ token })) {
        throw new MemoryCoreError('OWNERSHIP_LOST', 'MemoryCore lock ownership changed; preserving the directory')
      }
      await rm(lock, { recursive: true })
      released = true
    }
  }
}

const exists = async (path: string): Promise<boolean> => {
  try {
    await access(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false
    }
    throw error
  }
}

const downloadArchive = async (): Promise<Buffer> => {
  const response = await fetch(
    `https://codeload.github.com/TencentCloud/TencentDB-Agent-Memory/tar.gz/${MEMORY_CORE_COMMIT}`,
    { signal: AbortSignal.timeout(120_000) }
  )
  if (!(response.ok && response.body)) {
    throw new MemoryCoreError('DOWNLOAD_FAILED', 'MemoryCore source download failed')
  }
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const chunk of response.body) {
    size += chunk.length
    if (size > 256 * 1024 * 1024) {
      throw new MemoryCoreError('DOWNLOAD_FAILED', 'MemoryCore source exceeds 256 MiB limit')
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

const command = async (executable: string, args: string[], cwd: string): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, args, { cwd, shell: false, stdio: 'ignore' })
    const timer = setTimeout(() => child.kill('SIGKILL'), 180_000)
    child.on('error', () => {})
    child.once('close', (code) => {
      clearTimeout(timer)
      if (code === 0) {
        resolve()
      } else {
        reject(new MemoryCoreError('INSTALL_FAILED', `MemoryCore installation command failed (exit ${code})`))
      }
    })
  })
}

const credential = (name: string): string => {
  const value = process.env[name]
  if (!value?.trim()) {
    throw new MemoryCoreError('MISSING_CREDENTIAL', 'A configured credential environment variable is empty')
  }
  return value
}

const validateOptions = (options: MemoryCoreOptions): void => {
  const invalid = () => {
    throw new MemoryCoreError('INVALID_CONFIG', 'Invalid MemoryCore endpoint, model, identity or environment reference')
  }
  try {
    const endpoint = new URL(options.endpoint ?? 'http://127.0.0.1:8420')
    const base = new URL(options.model.baseUrl)
    if (
      endpoint.protocol !== 'http:' ||
      !['127.0.0.1', '[::1]'].includes(endpoint.hostname) ||
      endpoint.username ||
      endpoint.password ||
      endpoint.pathname !== '/' ||
      endpoint.search ||
      endpoint.hash ||
      endpoint.port === '0'
    ) {
      invalid()
    }
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
      invalid()
    }
    if (
      [options.gatewayApiKeyEnv, options.model.apiKeyEnv].some(
        (name) => typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)
      )
    ) {
      invalid()
    }
    if (
      typeof options.serviceId !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(options.serviceId) ||
      !options.model.name?.trim()
    ) {
      invalid()
    }
    for (const value of [options.startupTimeoutMs, options.shutdownTimeoutMs]) {
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 1 || value > 120_000)) {
        invalid()
      }
    }
  } catch {
    invalid()
  }
}

export { MemoryError, ProjectMemory } from './project'

export type { MemoryConversation, MemoryReceipt, ProjectMemoryOptions } from './project'
