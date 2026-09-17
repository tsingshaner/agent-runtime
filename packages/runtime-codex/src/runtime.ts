import { createHash } from 'node:crypto'
import { chmod, copyFile, mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { RuntimeError } from '@qingshaner/runtime'

import type {
  AdapterNotice,
  AdapterOutcome,
  ApprovalDecision,
  InputAnswers,
  NativeSession,
  ResourceSnapshot,
  RuntimeAdapter
} from '@qingshaner/runtime'

import { CodexProcess, parseRuntimeOptions, resourceConfig } from './process'

import type { CodexRuntimeOptions, CodexSessionOptions } from './process'

export type { CodexRuntimeOptions, CodexSessionOptions } from './process'

/** Own one lazy app-server per project, sharing only within the project. */
export class CodexRuntime implements RuntimeAdapter {
  readonly kind = 'codex'
  private readonly options: ReturnType<typeof parseRuntimeOptions>
  private readonly projects = new Map<string, Promise<CodexProcess>>()
  private readonly active = new Map<string, Promise<CodexProcess>>()
  private readonly resources = new Map<string, ResourceSnapshot>()
  private disposed = false
  private closing?: Promise<void>

  constructor(options: CodexRuntimeOptions = {}) {
    this.options = parseRuntimeOptions(options)
  }

  async createSession(input: {
    cwd: string
    model?: string
    projectId?: string
    options?: CodexSessionOptions
  }): Promise<NativeSession> {
    const process = await this.project(input.projectId)
    this.checkOpen()
    const session = await process.createSession(input)
    return { ...session, ...(input.projectId === undefined ? {} : { projectId: input.projectId }) }
  }

  async resumeSession(session: NativeSession): Promise<void> {
    const process = await this.project(session.projectId)
    this.checkOpen()
    await process.resumeSession(session)
  }

  async execute(
    session: NativeSession,
    input: { sessionId: string; runId: string; text: string; context?: string },
    emit: (notice: AdapterNotice) => Promise<void>
  ): Promise<AdapterOutcome> {
    this.checkOpen()
    if (this.active.has(input.runId)) {
      throw new RuntimeError('RUN_CONFLICT', 'Run already exists')
    }
    const pending = this.project(session.projectId)
    this.active.set(input.runId, pending)
    try {
      const process = await pending
      this.checkOpen()
      return await process.execute(session, input, emit)
    } catch (error) {
      if (!this.disposed) {
        throw error
      }
      return {
        error: { code: 'PROCESS_EXITED', message: 'Runtime disposed before execution completed' },
        status: 'failed'
      }
    } finally {
      this.active.delete(input.runId)
    }
  }

  async cancel(runId: string): Promise<void> {
    this.checkOpen()
    await (await this.active.get(runId))?.cancel(runId)
  }

  async respondApproval(runId: string, nativeRequestId: string | number, decision: ApprovalDecision): Promise<void> {
    this.checkOpen()
    const process = await this.active.get(runId)
    if (!process) {
      throw new RuntimeError('APPROVAL_NOT_FOUND', 'No approval request for run')
    }
    await process.respondApproval(runId, nativeRequestId, decision)
  }

  async respondInput(runId: string, nativeRequestId: string | number, answers: InputAnswers): Promise<void> {
    this.checkOpen()
    const process = await this.active.get(runId)
    if (!process) {
      throw new RuntimeError('INPUT_NOT_FOUND', 'No input request for run')
    }
    await process.respondInput(runId, nativeRequestId, answers)
  }

  dispose(): Promise<void> {
    this.disposed = true
    this.closing ??= (async () => {
      const children = await Promise.allSettled(this.projects.values())
      const results = await Promise.allSettled(
        children.filter((child) => child.status === 'fulfilled').map((child) => child.value.dispose())
      )
      const errors = results.filter((result) => result.status === 'rejected').map((result) => result.reason)
      if (errors.length > 0) {
        throw new AggregateError(errors, 'Failed to close project processes')
      }
    })()
    return this.closing
  }

  configureProject = async (projectId: string, snapshot: ResourceSnapshot): Promise<void> => {
    this.checkOpen()
    if (JSON.stringify(this.resources.get(projectId)) === JSON.stringify(snapshot)) {
      return
    }
    const previous = this.projects.get(projectId)
    if (previous && [...this.active.values()].includes(previous)) {
      throw new RuntimeError('RESOURCES_UPDATING', 'Project has active runs')
    }
    if (previous) {
      await (await previous).updateResources(snapshot)
    }
    this.resources.set(projectId, snapshot)
  }

  private checkOpen(): void {
    if (this.disposed) {
      throw new RuntimeError('DISPOSED', 'Codex runtime disposed')
    }
  }

  private project(projectId?: string): Promise<CodexProcess> {
    this.checkOpen()
    if (projectId !== undefined && (typeof projectId !== 'string' || !projectId.trim())) {
      throw new RuntimeError('INVALID_INPUT', 'Invalid project ID')
    }
    const key = projectId ?? ''
    let pending = this.projects.get(key)
    if (!pending) {
      pending = this.prepareProject(key).catch((error: unknown) => {
        this.projects.delete(key)
        throw error
      })
      this.projects.set(key, pending)
    }
    return pending
  }

  private async prepareProject(projectId: string): Promise<CodexProcess> {
    const root = join(
      this.options.dataDir ?? join(homedir(), '.local', 'share', 'agent-runtime', 'codex'),
      createHash('sha256').update(projectId).digest('hex')
    )
    const home = join(root, 'codex')
    const userHome = join(root, 'user')
    await mkdir(home, { mode: 0o700, recursive: true })
    await mkdir(userHome, { mode: 0o700, recursive: true })
    const authHome = this.options.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), '.codex')
    try {
      await copyFile(join(authHome, 'auth.json'), join(home, 'auth.json'))
      await chmod(join(home, 'auth.json'), 0o600)
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
        throw error
      }
    }
    const resources = this.resources.get(projectId)
    await writeFile(join(home, 'config.toml'), resourceConfig(resources), { mode: 0o600 })
    this.checkOpen()
    return new CodexProcess({ ...this.options, codexHome: home }, userHome, authHome, resources)
  }
}
