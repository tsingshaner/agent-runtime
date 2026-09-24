import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { type ResourceSnapshot, RuntimeError } from '@qingshaner/runtime'
import { FilesystemBackend } from 'deepagents'
import { z } from 'zod'

import type { DeepAgentsTool } from './index'

/** Track the actual filesystem promise, before native Runnable cancellation races it. */
export const filesystem = (cwd: string, pending: Set<Promise<unknown>>) =>
  new Proxy(new FilesystemBackend({ rootDir: cwd }), {
    get(target, key) {
      const value = Reflect.get(target, key, target)
      if (typeof value !== 'function') {
        return value
      }
      return (...args: unknown[]) => {
        const result = Promise.resolve(Reflect.apply(value, target, args))
        pending.add(result)
        void result.finally(() => pending.delete(result)).catch(() => {})
        return result
      }
    }
  })

export const openResources = async (
  snapshot: ResourceSnapshot | undefined,
  signal: AbortSignal,
  onUnconfirmed: () => void
) => {
  const tools: DeepAgentsTool[] = []
  if (!snapshot) {
    return { close: () => Promise.resolve(), tools }
  }
  const client = new Client({ name: 'runtime-deepagents', version: '0.0.0' })
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(snapshot.url), {
        requestInit: { headers: { Authorization: snapshot.token } }
      })
    )
    const listed = await client.listTools({}, { signal, timeout: 10000 })
    for (const entry of listed.tools) {
      const schema = z.fromJSONSchema(entry.inputSchema as Parameters<typeof z.fromJSONSchema>[0])
      if (!(schema instanceof z.ZodObject)) {
        throw new Error('Unsupported tool schema')
      }
      tools.push({
        description: entry.description ?? entry.name,
        execute: async (args, signal) => {
          try {
            const result = await client.callTool({ arguments: args, name: entry.name }, undefined, {
              signal,
              timeout: 30000
            })
            if (result.isError) {
              throw new Error('Project resource tool failed')
            }
            return JSON.stringify(result.content)
          } finally {
            if (signal.aborted) {
              onUnconfirmed()
            }
          }
        },
        name: entry.name,
        schema
      })
    }
    return { close: () => client.close(), tools }
  } catch {
    await client.close()
    throw new RuntimeError('RESOURCE_PREPARATION_FAILED', 'Project resource bridge unavailable or incompatible')
  }
}
