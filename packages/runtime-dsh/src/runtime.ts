import { randomUUID } from 'node:crypto'
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client'
import { RuntimeError } from '@qingshaner/runtime'

import type {
  AdapterNotice,
  AdapterOutcome,
  ApprovalDecision,
  NativeSession,
  RuntimeAdapter
} from '@qingshaner/runtime'

import { Projection, readFrames } from './events'

export interface DshRuntimeOptions {
  dataDir: string
  apiKeyEnv?: string
  baseURL?: string
  controlTimeoutMs?: number
}
export type DshSessionOptions = Record<string, never>
type Child = { harness: DeepSeekHarness; url: string; token: string; session: NativeSession; directory: string }

export class DshRuntime implements RuntimeAdapter {
  readonly kind = 'dsh'
  readonly #children = new Map<string, Promise<Child>>()
  readonly #active = new Map<string, Child>()
  #disposed = false
  #closing?: Promise<void>
  constructor(readonly options: DshRuntimeOptions) {
    if (
      !options.dataDir ||
      (options.controlTimeoutMs !== undefined &&
        (!Number.isFinite(options.controlTimeoutMs) || options.controlTimeoutMs <= 0))
    ) {
      throw new RuntimeError('INVALID_INPUT', 'Invalid DSH options')
    }
  }
  createSession = async (input: {
    cwd: string
    model?: string
    projectId?: string
    options?: DshSessionOptions
  }): Promise<NativeSession> => {
    if (!input.model || Object.keys(input.options ?? {}).length > 0) {
      throw new RuntimeError('INVALID_INPUT', 'DSH requires an explicit model and no session overrides')
    }
    const session: NativeSession = {
      cwd: input.cwd,
      model: input.model,
      nativeSessionId: randomUUID(),
      options: {},
      projectId: input.projectId
    }
    await this.#load(session, true)
    return session
  }
  resumeSession = async (session: NativeSession): Promise<void> => {
    await this.#load(session, false)
  }
  #load = (session: NativeSession, create: boolean): Promise<Child> => {
    if (this.#disposed) {
      throw new RuntimeError('DISPOSED', 'DSH runtime disposed')
    }
    if (!(/^[a-zA-Z0-9-]{1,128}$/.test(session.nativeSessionId) && session.model)) {
      throw new RuntimeError('INVALID_INPUT', 'Invalid DSH session')
    }
    let child = this.#children.get(session.nativeSessionId)
    if (!child) {
      child = this.#launch(session, create).catch((error) => {
        this.#children.delete(session.nativeSessionId)
        throw error
      })
      this.#children.set(session.nativeSessionId, child)
    }
    return child
  }
  #checkHistory = async (directory: string) => {
    // An unfinished turn may contain queued side effects; never ask native recovery to repair/replay it.
    try {
      await access(join(directory, 'active'))
      throw new RuntimeError('UNSAFE_RESUME', 'Previous DSH execution was not confirmed idle')
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
        throw error
      }
    }
    try {
      await access(join(directory, 'created'))
    } catch {
      throw new RuntimeError('SESSION_NOT_FOUND', 'DSH session history missing')
    }
  }
  #launch = async (session: NativeSession, create: boolean): Promise<Child> => {
    const directory = join(resolve(this.options.dataDir), session.nativeSessionId)
    if (!create) {
      await this.#checkHistory(directory)
    }
    await mkdir(directory, { mode: 0o700, recursive: true })
    const token = randomUUID()
    const addressFile = join(directory, `control-${randomUUID()}.json`)
    const patch = join(directory, 'runtime.patch.json')
    const source = import.meta.url.endsWith('.ts') ? './control.ts' : './control.mjs'
    await writeFile(
      patch,
      JSON.stringify([
        {
          config: {
            apiKeyEnv: 'DEEPSEEK_API_KEY',
            baseURL: this.options.baseURL ?? 'https://api.deepseek.com',
            thinking: 'disabled'
          },
          id: 'llm-deepseek'
        },
        { insert: [{ id: 'runtime-control', name: fileURLToPath(new URL(source, import.meta.url)) }] }
      ]),
      { mode: 0o600 }
    )
    const harness = new DeepSeekHarness({
      cwd: session.cwd,
      dshHome: join(directory, 'home'),
      env: {
        DEEPSEEK_API_KEY: process.env[this.options.apiKeyEnv ?? 'DEEPSEEK_API_KEY'],
        HOME: directory,
        PATH: process.env.PATH,
        RUNTIME_DSH_ADDRESS: addressFile,
        RUNTIME_DSH_MODEL: session.model,
        RUNTIME_DSH_SESSION: session.nativeSessionId,
        RUNTIME_DSH_TOKEN: token
      },
      initializeTimeoutMs: 30000,
      model: session.model,
      patches: [patch],
      processCwd: session.cwd,
      profile: 'sdk-minimal'
    })
    try {
      await harness.start()
      let port: number | undefined
      for (let i = 0; i < 100; i++) {
        try {
          port = JSON.parse(await readFile(addressFile, 'utf8')).port
          break
        } catch {
          await delay(20)
        }
      }
      if (!Number.isInteger(port)) {
        throw new RuntimeError('CONTROL_UNAVAILABLE', 'DSH control did not start')
      }
      const child = { directory, harness, session, token, url: `http://127.0.0.1:${port}` }
      await this.#call(child, create ? '/create' : '/resume', {})
      if (create) {
        await writeFile(join(directory, 'created'), '1', { mode: 0o600 })
      }
      return child
    } catch (error) {
      await harness.close()
      if (error instanceof RuntimeError) {
        throw error
      }
      throw new RuntimeError('DSH_START_FAILED', 'DSH startup or native session load failed')
    } finally {
      await rm(addressFile, { force: true })
    }
  }
  #call = async (child: Child, path: string, body: unknown) => {
    const response = await fetch(`${child.url}${path}`, {
      body: JSON.stringify(body),
      headers: { authorization: `Bearer ${child.token}`, 'content-type': 'application/json' },
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(this.options.controlTimeoutMs ?? 10000)
    })
    if (!response.ok) {
      throw new RuntimeError('DSH_OPERATION_REJECTED', `DSH control rejected ${path} (${response.status})`)
    }
    await response.body?.cancel()
  }
  execute = async (
    session: NativeSession,
    input: { sessionId: string; runId: string; text: string; context?: string },
    emit: (notice: AdapterNotice) => Promise<void>
  ): Promise<AdapterOutcome> => {
    const child = await this.#load(session, false)
    this.#active.set(input.runId, child)
    const projection = new Projection(input.runId, emit)
    try {
      await writeFile(join(child.directory, 'active'), input.runId, { mode: 0o600 })
      const response = await fetch(`${child.url}/run`, {
        body: JSON.stringify({ text: input.context ? `${input.context}\n\n${input.text}` : input.text }),
        headers: { authorization: `Bearer ${child.token}`, 'content-type': 'application/json' },
        method: 'POST',
        redirect: 'error'
      })
      if (!(response.ok && response.body)) {
        throw new RuntimeError('DSH_PROTOCOL_ERROR', 'DSH run rejected')
      }
      for await (const frame of readFrames(response.body)) {
        await projection.accept(frame)
      }
      if (!(projection.idle && projection.outcome)) {
        throw new RuntimeError('DSH_PROTOCOL_ERROR', 'DSH execution ended without idle confirmation')
      }
      await rm(join(child.directory, 'active'))
      return { ...projection.outcome, finalReply: projection.finalReply }
    } catch {
      await child.harness.close()
      this.#children.delete(session.nativeSessionId)
      throw new RuntimeError(
        'DSH_EXECUTION_LOST',
        'DSH execution lost; native history retained and unsafe resume blocked'
      )
    } finally {
      this.#active.delete(input.runId)
    }
  }
  cancel = async (runId: string): Promise<void> => {
    const child = this.#active.get(runId)
    if (child) {
      await this.#call(child, '/cancel', {})
    }
  }
  respondApproval = async (
    _runId: string,
    _nativeRequestId: string | number,
    _decision: ApprovalDecision
  ): Promise<void> => {
    throw new RuntimeError('APPROVAL_NOT_FOUND', 'No DSH approval pending')
  }
  dispose = (): Promise<void> => {
    this.#disposed = true
    this.#closing ??= (async () => {
      const children = await Promise.allSettled(this.#children.values())
      await Promise.all(
        children.filter((child) => child.status === 'fulfilled').map((child) => child.value.harness.close())
      )
    })()
    return this.#closing
  }
}
