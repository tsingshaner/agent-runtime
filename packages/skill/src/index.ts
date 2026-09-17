import { randomUUID } from 'node:crypto'
import { cp, lstat, mkdir, readdir, realpath, rename, rm } from 'node:fs/promises'
import { join, relative } from 'node:path'

import { atomicWrite, FileError, readRegularFile, resourcePath } from '@internal/shared/files'
import * as v from 'valibot'
import { parse as parseYaml } from 'yaml'

export { FileError as SkillError } from '@internal/shared/files'
export interface Skill {
  id: string
  name: string
  description: string
  directory: string
  enabled?: boolean
}
const key = v.pipe(v.string(), v.minLength(1))
const stateSchema = v.object({
  bindings: v.record(key, v.record(key, v.boolean())),
  ids: v.array(v.pipe(v.string(), v.uuid()))
})
type State = v.InferOutput<typeof stateSchema>
const parse = <S extends v.GenericSchema>(schema: S, input: unknown): v.InferOutput<S> => {
  const result = v.safeParse(schema, input)
  if (!result.success) {
    throw new FileError('INVALID_INPUT', 'Invalid skill input')
  }
  return result.output
}
const metadata = (text: string): { name: string; description: string } => {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)?.[1]
  try {
    if (!frontmatter) {
      throw new Error('Missing frontmatter')
    }
    return v.parse(v.object({ description: key, name: key }), parseYaml(frontmatter))
  } catch {
    throw new FileError('INVALID_SKILL', 'SKILL.md requires name and description frontmatter')
  }
}
const checkTree = async (directory: string): Promise<void> => {
  if (!(await lstat(directory)).isDirectory()) {
    throw new FileError('INVALID_PATH', 'Expected a directory')
  }
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      await checkTree(join(directory, entry.name))
    } else if (!entry.isFile()) {
      throw new FileError('INVALID_PATH', 'Skills may contain only regular files and directories')
    }
  }
}

/** Owns copies only, with explicit persisted project allowlists. */
export class Skills {
  private queue: Promise<unknown> = Promise.resolve()
  private constructor(private readonly directory: string) {}
  static open = async (dataDir: string): Promise<Skills> => {
    parse(key, dataDir)
    await mkdir(dataDir, { recursive: true })
    return new Skills(await realpath(dataDir))
  }
  private load = async (): Promise<State> => {
    try {
      return parse(stateSchema, JSON.parse(await readRegularFile(join(this.directory, 'skills.json'))))
    } catch (error) {
      if (error instanceof FileError && error.code === 'NOT_FOUND') {
        return { bindings: {}, ids: [] }
      }
      throw error
    }
  }
  private mutate = <T>(operation: (state: State) => Promise<T> | T): Promise<T> => {
    const pending = this.queue.then(async () => {
      const lock = join(this.directory, 'skills.lock')
      try {
        await mkdir(lock)
      } catch {
        throw new FileError('RESOURCE_BUSY', 'Skills are being updated')
      }
      try {
        const state = await this.load()
        const result = await operation(state)
        await atomicWrite(join(this.directory, 'skills.json'), JSON.stringify(state))
        return result
      } finally {
        await rm(lock, { recursive: true })
      }
    })
    this.queue = pending.catch(() => {})
    return pending
  }
  private skillDirectory = async (id: string): Promise<string> => {
    parse(v.pipe(v.string(), v.uuid()), id)
    if (!(await this.load()).ids.includes(id)) {
      throw new FileError('NOT_FOUND', 'Skill not found')
    }
    return resourcePath(this.directory, id)
  }
  import = (source: string): Promise<Skill> =>
    this.mutate(async (state) => {
      parse(key, source)
      const root = await realpath(source)
      const relation = relative(root, this.directory)
      if (!(relation && (relation === '..' || relation.startsWith('../') || relation.startsWith('/')))) {
        throw new FileError('INVALID_PATH', 'Source cannot contain the managed directory')
      }
      await checkTree(root)
      metadata(await readRegularFile(join(root, 'SKILL.md')))
      const id = randomUUID()
      const staging = join(this.directory, `${id}.tmp`)
      const target = join(this.directory, id)
      try {
        await cp(root, staging, { dereference: false, errorOnExist: true, force: false, recursive: true })
        await checkTree(staging)
        const detail = metadata(await readRegularFile(join(staging, 'SKILL.md')))
        await rename(staging, target)
        state.ids.push(id)
        return { id, ...detail, directory: target }
      } finally {
        await rm(staging, { force: true, recursive: true })
      }
    })
  get = async (id: string): Promise<Skill> => {
    const directory = await this.skillDirectory(id)
    return { directory, id, ...metadata(await readRegularFile(await resourcePath(directory, 'SKILL.md'))) }
  }
  list = async (projectId?: string): Promise<Skill[]> => {
    if (projectId !== undefined) {
      parse(key, projectId)
    }
    const state = await this.load()
    const bindings =
      projectId !== undefined && Object.hasOwn(state.bindings, projectId) ? state.bindings[projectId] : undefined
    const ids = projectId === undefined ? state.ids : Object.keys(bindings ?? {})
    return Promise.all(
      ids.map(async (id) => ({ ...(await this.get(id)), ...(bindings ? { enabled: bindings[id] } : {}) }))
    )
  }
  enabled = async (projectId: string): Promise<Skill[]> => {
    parse(key, projectId)
    const state = await this.load()
    const bindings = Object.hasOwn(state.bindings, projectId) ? state.bindings[projectId] : undefined
    return Promise.all(
      Object.entries(bindings ?? {})
        .filter(([, enabled]) => enabled)
        .map(async ([id]) => ({ ...(await this.get(id)), enabled: true }))
    )
  }
  bind = (projectId: string, id: string, enabled: boolean): Promise<void> =>
    this.mutate(async (state) => {
      parse(key, projectId)
      parse(v.boolean(), enabled)
      await this.get(id)
      const bindings = Object.hasOwn(state.bindings, projectId) ? state.bindings[projectId] : {}
      state.bindings = { ...state.bindings, [projectId]: { ...bindings, [id]: enabled } }
    })
  unbind = (projectId: string, id: string): Promise<void> =>
    this.mutate((state) => {
      parse(key, projectId)
      parse(v.pipe(v.string(), v.uuid()), id)
      if (Object.hasOwn(state.bindings, projectId)) {
        delete state.bindings[projectId]?.[id]
      }
    })
  read = async (id: string, path = 'SKILL.md'): Promise<string> =>
    readRegularFile(await resourcePath(await this.skillDirectory(id), path))
  edit = (id: string, path: string, content: string): Promise<void> =>
    this.mutate(async () => {
      parse(v.string(), content)
      const target = await resourcePath(await this.skillDirectory(id), path)
      await readRegularFile(target)
      if (path === 'SKILL.md') {
        metadata(content)
      }
      await atomicWrite(target, content)
    })
  delete = (id: string): Promise<void> =>
    this.mutate(async (state) => {
      const target = await this.skillDirectory(id)
      state.ids = state.ids.filter((value) => value !== id)
      for (const bindings of Object.values(state.bindings)) {
        delete bindings[id]
      }
      // Persist removal before deleting; a crash can leave an unreferenced copy, never a missing active skill.
      await atomicWrite(join(this.directory, 'skills.json'), JSON.stringify(state))
      await rm(target, { recursive: true })
    })
}
