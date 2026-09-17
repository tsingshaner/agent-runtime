import type { IncomingMessage } from 'node:http'
import { ProjectMemory } from '@qingshaner/memory'
import { RuntimeError } from '@qingshaner/runtime'
import * as v from 'valibot'

import type { MemoryCoreService } from '@qingshaner/memory'
import type { ManagerOptions, RuntimeManager } from '@qingshaner/runtime'

import { body, parse } from './http.ts'

export interface ResourceServerOptions {
  memoryCore?: MemoryCoreService
}
const need = <T>(value: T | undefined): T => {
  if (!value) {
    throw new RuntimeError('RESOURCE_UNAVAILABLE', 'Resource service not configured')
  }
  return value
}
const text = v.pipe(v.string(), v.minLength(1))
const content = v.strictObject({ content: v.string() })
const enabled = v.strictObject({ enabled: v.boolean() })
const document = v.strictObject({ content: v.string(), path: text })
const missing = (): never => {
  throw new RuntimeError('ROUTE_NOT_FOUND', 'Route not found')
}

export const resourceRoute = async (
  request: IncomingMessage,
  parts: string[],
  target: URL,
  manager: RuntimeManager,
  options: ManagerOptions & ResourceServerOptions
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Thin HTTP dispatch; SDKs own validation and resource behavior.
): Promise<{ value: unknown } | null> => {
  const [resource, id = '', action, item = ''] = parts
  const method = request.method
  const resources = options.resources?.options
  let value: unknown
  if (resource === 'memory-core' && parts.length <= 2) {
    const core = need(options.memoryCore)
    if (method === 'GET' && !id) {
      value = await core.status()
    } else if (method === 'POST') {
      if (id === 'install') {
        value = await core.install(parse(v.strictObject({ archivePath: v.optional(text) }), await body(request)))
      } else {
        parse(v.strictObject({}), await body(request))
        if (id === 'start') {
          value = await core.start()
        } else if (id === 'stop') {
          await core.stop()
          value = await core.status()
        } else {
          missing()
        }
      }
    } else {
      missing()
    }
  } else if (resource === 'skills' && parts.length <= 3) {
    const skills = need(resources?.skills)
    if (method === 'GET') {
      value =
        action === 'file' && id
          ? { content: await skills.read(id, target.searchParams.get('path') ?? 'SKILL.md') }
          : id
            ? await skills.get(id)
            : await skills.list()
    } else if (method === 'POST' && !id) {
      value = await skills.import(parse(v.strictObject({ source: text }), await body(request)).source)
    } else if (method === 'PATCH' && id && action === 'file') {
      const input = parse(document, await body(request))
      await manager.updateSharedResources(() => skills.edit(id, input.path, input.content))
    } else if (method === 'DELETE' && id && !action) {
      await manager.updateSharedResources(() => skills.delete(id))
    } else {
      missing()
    }
  } else if (resource === 'mcp' && parts.length <= 3) {
    const mcp = need(resources?.mcp)
    if (method === 'GET' && !action) {
      value = id ? await mcp.get(id) : await mcp.list()
    } else if (method === 'POST' && !id) {
      value = await mcp.create((await body(request)) as never)
    } else if (method === 'POST' && id && action === 'probe') {
      parse(v.strictObject({}), await body(request))
      value = await mcp.probe(id)
    } else if (method === 'PATCH' && id && !action) {
      const input = await body(request)
      await manager.updateSharedResources(async () => {
        await mcp.update(id, input as never)
      })
    } else if (method === 'DELETE' && id && !action) {
      await manager.updateSharedResources(() => mcp.delete(id))
    } else {
      missing()
    }
  } else if (resource === 'runs' && action === 'memory-write' && parts.length === 3 && method === 'GET') {
    value = await manager.getMemoryWrite(id)
  } else if (
    resource === 'projects' &&
    id &&
    ['knowledge', 'skills', 'mcp', 'memory', 'memory-writes', 'resources'].includes(action ?? '') &&
    parts.length <= 4
  ) {
    await manager.getProject(id)
    if (action === 'resources' && method === 'POST' && !item) {
      parse(v.strictObject({}), await body(request))
      await manager.updateProjectResources(id, () => Promise.resolve())
    } else if (action === 'memory-writes' && method === 'GET' && !item) {
      value = await manager.listMemoryWrites(id)
    } else if (action === 'skills' || action === 'mcp') {
      const library = need(action === 'skills' ? resources?.skills : resources?.mcp)
      if (method === 'GET' && !item) {
        value = await library.list(id)
      } else if (method === 'POST' && item) {
        const input = parse(enabled, await body(request))
        await manager.updateProjectResources(id, () => library.bind(id, item, input.enabled))
      } else if (method === 'DELETE' && item) {
        await manager.updateProjectResources(id, () => library.unbind(id, item))
      } else {
        missing()
      }
    } else if (action === 'knowledge') {
      const knowledge = need(resources?.knowledge)
      if (item === 'binding') {
        if (method === 'GET') {
          value = { directory: await knowledge.binding(id) }
        } else if (method === 'POST') {
          const input = parse(v.strictObject({ directory: text }), await body(request))
          await manager.updateProjectResources(id, () => knowledge.bind(id, input.directory))
        } else if (method === 'DELETE') {
          await manager.updateProjectResources(id, () => knowledge.unbind(id))
        } else {
          missing()
        }
      } else if (item === 'documents') {
        const path = target.searchParams.get('path')
        if (method === 'GET') {
          value = path === null ? await knowledge.list(id) : { content: await knowledge.read(id, path) }
        } else if (method === 'POST' || method === 'PATCH') {
          const input = parse(document, await body(request))
          await knowledge[method === 'POST' ? 'create' : 'edit'](id, input.path, input.content)
        } else if (method === 'DELETE') {
          await knowledge.delete(id, parse(text, path))
        } else {
          missing()
        }
      } else if (item === 'search' && method === 'GET') {
        value = await knowledge.search(id, parse(text, target.searchParams.get('q')))
      } else {
        missing()
      }
    } else if (action === 'memory') {
      const memory = need(options.memory instanceof ProjectMemory ? options.memory : undefined)
      const page = {
        limit: target.searchParams.has('limit') ? Number(target.searchParams.get('limit')) : undefined,
        offset: target.searchParams.has('offset') ? Number(target.searchParams.get('offset')) : undefined
      }
      if (method === 'GET') {
        if (!item) {
          value = await memory.query(id, page)
        } else if (item === 'conversations') {
          value = await memory.conversations(id, page)
        } else if (item === 'search') {
          value = await memory.search(id, parse(text, target.searchParams.get('q')))
        } else if (item === 'core') {
          value = await memory.readCore(id)
        } else {
          missing()
        }
      } else if (method === 'PATCH' && item) {
        const input = parse(content, await body(request))
        value =
          item === 'core' ? await memory.writeCore(id, input.content) : await memory.update(id, item, input.content)
      } else if (method === 'DELETE' && (!item || item === 'conversations')) {
        const input = parse(v.strictObject({ ids: v.array(text) }), await body(request))
        value =
          item === 'conversations'
            ? await memory.deleteConversations(id, input.ids)
            : await memory.delete(id, input.ids)
      } else {
        missing()
      }
    } else {
      missing()
    }
  } else {
    return null
  }
  return { value }
}
