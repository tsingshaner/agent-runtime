import { lstat, mkdir, readdir, realpath, rm } from 'node:fs/promises'
import { join, relative } from 'node:path'

import { atomicWrite, FileError as KnowledgeError, readRegularFile as read, resourcePath } from '@internal/shared/files'
import * as v from 'valibot'

export { FileError as KnowledgeError } from '@internal/shared/files'

const nonempty = v.pipe(v.string(), v.minLength(1), v.maxLength(4096))
const bindingSchema = v.record(nonempty, nonempty)
const validate = <S extends v.GenericSchema>(schema: S, value: unknown): v.InferOutput<S> => {
  const result = v.safeParse(schema, value)
  if (!result.success) {
    throw new KnowledgeError('INVALID_INPUT', 'Invalid knowledge input')
  }
  return result.output
}
/** Markdown operations on explicitly bound local directories; no runtime dependency. */
export class Knowledge {
  private queue: Promise<unknown> = Promise.resolve()
  private constructor(
    private readonly manifest: string,
    private bindings: Record<string, string>
  ) {}

  static async open(dataDir: string): Promise<Knowledge> {
    validate(nonempty, dataDir)
    await mkdir(dataDir, { recursive: true })
    const manifest = join(await realpath(dataDir), 'bindings.json')
    let bindings: Record<string, string> = {}
    try {
      bindings = validate(bindingSchema, JSON.parse(await read(manifest)))
    } catch (error) {
      if (!(error instanceof KnowledgeError && error.code === 'NOT_FOUND')) {
        throw error
      }
    }
    return new Knowledge(manifest, bindings)
  }

  private load = async (): Promise<Record<string, string>> => {
    try {
      return validate(bindingSchema, JSON.parse(await read(this.manifest)))
    } catch (error) {
      if (error instanceof KnowledgeError && error.code === 'NOT_FOUND') {
        return {}
      }
      throw error
    }
  }

  private exclusive = <T>(operation: () => Promise<T>): Promise<T> => {
    const pending = this.queue.then(async () => {
      const lock = `${this.manifest}.lock`
      try {
        await mkdir(lock)
      } catch {
        throw new KnowledgeError('RESOURCE_BUSY', 'Knowledge is being updated')
      }
      try {
        this.bindings = await this.load()
        return await operation()
      } finally {
        await rm(lock, { recursive: true })
      }
    })
    this.queue = pending.catch(() => {})
    return pending
  }

  bind = (projectId: string, directory: string): Promise<void> =>
    this.exclusive(async () => {
      validate(nonempty, projectId)
      validate(nonempty, directory)
      const root = await realpath(directory)
      if (!(await lstat(root)).isDirectory()) {
        throw new KnowledgeError('INVALID_PATH', 'Expected a directory')
      }
      const next = { ...this.bindings, [projectId]: root }
      await atomicWrite(this.manifest, JSON.stringify(next))
      this.bindings = next
    })

  unbind = (projectId: string): Promise<void> =>
    this.exclusive(async () => {
      validate(nonempty, projectId)
      const next = { ...this.bindings }
      delete next[projectId]
      await atomicWrite(this.manifest, JSON.stringify(next))
      this.bindings = next
    })

  binding = async (projectId: string): Promise<string> => {
    validate(nonempty, projectId)
    const bindings = await this.load()
    const root = Object.hasOwn(bindings, projectId) ? bindings[projectId] : undefined
    if (!root) {
      throw new KnowledgeError('NOT_BOUND', 'Project has no knowledge binding')
    }
    if ((await realpath(root)) !== root || !(await lstat(root)).isDirectory()) {
      throw new KnowledgeError('INVALID_PATH', 'Binding changed')
    }
    return root
  }

  private path = async (projectId: string, path: string): Promise<string> => {
    if (typeof path !== 'string' || !path.endsWith('.md')) {
      throw new KnowledgeError('INVALID_PATH', 'Expected a Markdown path')
    }
    return resourcePath(await this.binding(projectId), path)
  }

  list = async (projectId: string): Promise<string[]> => {
    const root = await this.binding(projectId)
    const paths: string[] = []
    const visit = async (directory: string) => {
      if ((await realpath(directory)) !== directory || (await lstat(directory)).isSymbolicLink()) {
        throw new KnowledgeError('INVALID_PATH', 'Directory changed')
      }
      for (const item of await readdir(directory, { withFileTypes: true })) {
        if (item.isSymbolicLink()) {
          continue
        }
        const path = join(directory, item.name)
        if (item.isDirectory()) {
          await visit(path)
        } else if (item.isFile() && item.name.endsWith('.md')) {
          paths.push(relative(root, path))
        }
      }
    }
    await visit(root)
    return paths.sort()
  }

  read = async (projectId: string, path: string): Promise<string> => read(await this.path(projectId, path))
  create = (projectId: string, path: string, content: string): Promise<void> =>
    this.exclusive(async () => {
      validate(v.string(), content)
      await atomicWrite(await this.path(projectId, path), content, true)
    })
  edit = (projectId: string, path: string, content: string): Promise<void> =>
    this.exclusive(async () => {
      validate(v.string(), content)
      const target = await this.path(projectId, path)
      await read(target)
      await atomicWrite(target, content)
    })
  delete = (projectId: string, path: string): Promise<void> =>
    this.exclusive(async () => {
      const target = await this.path(projectId, path)
      await read(target)
      await rm(target)
    })
  search = async (projectId: string, query: string, limit = 20): Promise<{ path: string; excerpt: string }[]> => {
    validate(nonempty, query)
    validate(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(100)), limit)
    const matches: { path: string; excerpt: string }[] = []
    for (const path of await this.list(projectId)) {
      const content = await this.read(projectId, path)
      const index = content.toLocaleLowerCase().indexOf(query.toLocaleLowerCase())
      if (index >= 0) {
        matches.push({ excerpt: content.slice(Math.max(0, index - 80), index + 240), path })
      }
      if (matches.length === limit) {
        break
      }
    }
    return matches
  }
}
