import { randomUUID } from 'node:crypto'
import { mkdir, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import { atomicWrite, FileError, readRegularFile } from '@internal/shared/files'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { ErrorCode, McpError as ProtocolError } from '@modelcontextprotocol/sdk/types.js'
import * as v from 'valibot'

import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js'

export { FileError as McpError } from '@internal/shared/files'

const nonempty = v.pipe(v.string(), v.minLength(1))
const variable = v.pipe(v.string(), v.regex(/^[A-Za-z_][A-Za-z0-9_]*$/))
const common = {
  name: v.pipe(nonempty, v.regex(/^[a-zA-Z0-9_-]+$/)),
  timeoutMs: v.optional(v.pipe(v.number(), v.integer(), v.minValue(10), v.maxValue(120000)), 10000)
}
const configSchema = v.variant('transport', [
  v.strictObject({
    ...common,
    args: v.optional(v.array(v.string()), []),
    command: nonempty,
    cwd: v.optional(nonempty),
    env: v.optional(v.record(variable, variable), {}),
    transport: v.literal('stdio')
  }),
  v.strictObject({
    ...common,
    headers: v.optional(v.record(v.pipe(v.string(), v.regex(/^[A-Za-z0-9-]+$/)), variable), {}),
    transport: v.literal('http'),
    url: v.pipe(
      v.string(),
      v.check((value) => {
        try {
          const url = new URL(value)
          return (
            ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash
          )
        } catch {
          return false
        }
      })
    )
  })
])
export type McpConfig = v.InferInput<typeof configSchema>
export type McpServer = v.InferOutput<typeof configSchema> & { id: string }
export interface McpConnection {
  check: () => Promise<void>
  tools: Tool[]
  callTool: (name: string, args: Record<string, unknown>) => Promise<CallToolResult>
  close: () => Promise<void>
}
const stateSchema = v.object({
  bindings: v.record(nonempty, v.record(nonempty, v.boolean())),
  configs: v.record(nonempty, configSchema)
})
type State = v.InferOutput<typeof stateSchema>
const parse = <S extends v.GenericSchema>(schema: S, input: unknown): v.InferOutput<S> => {
  const result = v.safeParse(schema, input)
  if (!result.success) {
    throw new FileError('INVALID_INPUT', 'Invalid MCP input')
  }
  return result.output
}
const redact = <T>(value: T, secrets: string[]): T =>
  JSON.parse(
    JSON.stringify(value, (_key, item: unknown) =>
      typeof item === 'string' ? secrets.reduce((text, secret) => text.replaceAll(secret, '[REDACTED]'), item) : item
    )
  ) as T

const discover = async (client: Client, timeout: number): Promise<Tool[]> => {
  const tools: Tool[] = []
  const cursors = new Set<string>()
  let cursor: string | undefined
  do {
    const page = await client.listTools(cursor ? { cursor } : undefined, { timeout })
    tools.push(...page.tools)
    if (tools.length > 1000) {
      throw new FileError('MCP_LIMIT', 'Too many MCP tools')
    }
    cursor = page.nextCursor
    if (cursor && cursors.has(cursor)) {
      throw new FileError('MCP_PROTOCOL_ERROR', 'MCP tool cursor repeated')
    }
    if (cursor) {
      cursors.add(cursor)
    }
  } while (cursor)
  return tools
}

const waitForExit = async (pid: number | null): Promise<void> => {
  if (pid === null) {
    return
  }
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      process.kill(pid, 0)
    } catch {
      return
    }
    await delay(10)
  }
  throw new FileError('MCP_CLOSE_FAILED', 'MCP child did not exit')
}

/** Persistent explicit project connections; no child is started until connect/probe. */
export class Mcp {
  private queue: Promise<unknown> = Promise.resolve()
  private readonly connections = new Set<McpConnection>()
  private readonly pending = new Set<Promise<McpConnection>>()
  private disposed = false
  private closing?: Promise<void>
  private constructor(private readonly directory: string) {}
  static open = async (dataDir: string): Promise<Mcp> => {
    parse(nonempty, dataDir)
    await mkdir(dataDir, { recursive: true })
    return new Mcp(await realpath(dataDir))
  }
  private load = async (): Promise<State> => {
    try {
      return parse(stateSchema, JSON.parse(await readRegularFile(join(this.directory, 'mcp.json'))))
    } catch (error) {
      if (error instanceof FileError && error.code === 'NOT_FOUND') {
        return { bindings: {}, configs: {} }
      }
      throw error
    }
  }
  private assertOpen = () => {
    if (this.disposed) {
      throw new FileError('DISPOSED', 'MCP manager disposed')
    }
  }
  private mutate = <T>(operation: (state: State) => T | Promise<T>): Promise<T> => {
    this.assertOpen()
    const pending = this.queue.then(async () => {
      this.assertOpen()
      const lock = join(this.directory, 'mcp.lock')
      try {
        await mkdir(lock)
      } catch {
        throw new FileError('RESOURCE_BUSY', 'MCP config is being updated')
      }
      try {
        const state = await this.load()
        const result = await operation(state)
        await atomicWrite(join(this.directory, 'mcp.json'), JSON.stringify(state))
        return result
      } finally {
        await rm(lock, { recursive: true })
      }
    })
    this.queue = pending.catch(() => {})
    return pending
  }
  create = (input: McpConfig): Promise<McpServer> =>
    this.mutate((state) => {
      const config = parse(configSchema, input)
      const id = randomUUID()
      state.configs[id] = config
      return { id, ...config }
    })
  update = (id: string, input: McpConfig): Promise<McpServer> =>
    this.mutate((state) => {
      this.lookup(state, id)
      const config = parse(configSchema, input)
      state.configs[id] = config
      return { id, ...config }
    })
  private lookup = (state: State, id: string): McpServer => {
    parse(nonempty, id)
    const config = Object.hasOwn(state.configs, id) ? state.configs[id] : undefined
    if (!config) {
      throw new FileError('NOT_FOUND', 'MCP server not found')
    }
    return { id, ...config }
  }
  get = async (id: string): Promise<McpServer> => this.lookup(await this.load(), id)
  list = async (): Promise<McpServer[]> =>
    Object.entries((await this.load()).configs).map(([id, config]) => ({ id, ...config }))
  delete = (id: string): Promise<void> =>
    this.mutate((state) => {
      this.lookup(state, id)
      delete state.configs[id]
      for (const bindings of Object.values(state.bindings)) {
        delete bindings[id]
      }
    })
  bind = (projectId: string, id: string, enabled: boolean): Promise<void> =>
    this.mutate((state) => {
      parse(nonempty, projectId)
      parse(v.boolean(), enabled)
      this.lookup(state, id)
      const bindings = Object.hasOwn(state.bindings, projectId) ? state.bindings[projectId] : {}
      state.bindings = { ...state.bindings, [projectId]: { ...bindings, [id]: enabled } }
    })
  unbind = (projectId: string, id: string): Promise<void> =>
    this.mutate((state) => {
      parse(nonempty, projectId)
      parse(nonempty, id)
      if (Object.hasOwn(state.bindings, projectId)) {
        delete state.bindings[projectId]?.[id]
      }
    })
  enabled = async (projectId: string): Promise<McpServer[]> => {
    parse(nonempty, projectId)
    const state = await this.load()
    const bindings = Object.hasOwn(state.bindings, projectId) ? state.bindings[projectId] : undefined
    return Object.entries(bindings ?? {})
      .filter(([, enabled]) => enabled)
      .map(([id]) => this.lookup(state, id))
  }
  connect = (projectId: string): Promise<McpConnection> =>
    this.track(async () => this.prepare(await this.enabled(projectId)))
  probe = async (id: string): Promise<Tool[]> => {
    const connection = await this.track(async () => this.prepare([await this.get(id)]))
    try {
      return connection.tools
    } finally {
      await connection.close()
    }
  }
  private track = (operation: () => Promise<McpConnection>): Promise<McpConnection> => {
    this.assertOpen()
    const pending = Promise.resolve()
      .then(operation)
      .finally(() => this.pending.delete(pending))
    this.pending.add(pending)
    return pending
  }
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Keep connection acquisition and all failure cleanup in one scope.
  private prepare = async (configs: McpServer[]): Promise<McpConnection> => {
    this.assertOpen()
    const cleanup: (() => Promise<void>)[] = []
    const secrets: string[] = []
    const owners = new Map<string, { client: Client; timeoutMs: number }>()
    const clients: { client: Client; timeoutMs: number }[] = []
    const tools: Tool[] = []
    let closed = false
    let closePromise: Promise<void> | undefined
    const connection: McpConnection = {
      callTool: async (name, args) => {
        if (closed) {
          throw new FileError('DISPOSED', 'MCP connection closed')
        }
        parse(nonempty, name)
        parse(v.record(v.string(), v.unknown()), args)
        const owner = owners.get(name)
        if (!owner) {
          throw new FileError('TOOL_NOT_FOUND', 'MCP tool not found')
        }
        try {
          return redact(
            (await owner.client.callTool({ arguments: args, name }, undefined, {
              timeout: owner.timeoutMs
            })) as CallToolResult,
            secrets
          )
        } catch (error) {
          await connection.close()
          if (
            (error instanceof ProtocolError && error.code === ErrorCode.RequestTimeout) ||
            (error instanceof Error && error.name === 'TimeoutError')
          ) {
            throw new FileError('MCP_TIMEOUT', 'MCP request timed out')
          }
          throw new FileError('MCP_CALL_FAILED', 'MCP tool call failed')
        }
      },
      check: async () => {
        if (closed) {
          throw new FileError('DISPOSED', 'MCP connection closed')
        }
        try {
          const current: Tool[] = []
          for (const { client, timeoutMs } of clients) {
            current.push(...(await discover(client, timeoutMs)))
          }
          if (JSON.stringify(redact(current, secrets)) !== JSON.stringify(tools)) {
            throw new FileError('MCP_CHANGED', 'MCP tool inventory changed; apply resources again')
          }
        } catch (error) {
          await connection.close()
          throw error
        }
      },
      close: () =>
        (closePromise ??= (async () => {
          closed = true
          const results = await Promise.allSettled(cleanup.map((close) => close()))
          if (results.some((result) => result.status === 'rejected')) {
            throw new FileError('MCP_CLOSE_FAILED', 'MCP cleanup failed')
          }
          this.connections.delete(connection)
        })()),
      tools
    }
    this.connections.add(connection)
    try {
      for (const config of configs) {
        const env: Record<string, string> = config.transport === 'stdio' ? getDefaultEnvironment() : {}
        for (const [target, source] of Object.entries(config.transport === 'stdio' ? config.env : config.headers)) {
          const value = process.env[source]
          if (!value) {
            throw new FileError('MISSING_CREDENTIAL', 'MCP environment reference is unavailable')
          }
          env[target] = value
          secrets.push(value)
        }
        const transport =
          config.transport === 'stdio'
            ? new StdioClientTransport({
                args: config.args,
                command: config.command,
                cwd: config.cwd,
                env,
                stderr: 'ignore'
              })
            : new StreamableHTTPClientTransport(new URL(config.url), {
                fetch: (url, init) =>
                  fetch(url, {
                    ...init,
                    redirect: 'error',
                    signal: AbortSignal.any([
                      ...(init?.signal ? [init.signal] : []),
                      AbortSignal.timeout(config.timeoutMs)
                    ])
                  }),
                reconnectionOptions: {
                  initialReconnectionDelay: 1000,
                  maxReconnectionDelay: 1000,
                  maxRetries: 0,
                  reconnectionDelayGrowFactor: 1
                },
                requestInit: { headers: env }
              })
        const client = new Client({ name: 'agent-runtime', version: '0.0.0' })
        const nativeClose = transport.close.bind(transport)
        let stopped: Promise<void> | undefined
        let cleanupFailed = false
        transport.close = () =>
          (stopped ??= (async () => {
            const pid = transport instanceof StdioClientTransport ? transport.pid : null
            try {
              if (transport instanceof StreamableHTTPClientTransport) {
                await transport.terminateSession()
              }
            } finally {
              await nativeClose()
            }
            await waitForExit(pid)
          })().catch(() => {
            cleanupFailed = true
          }))
        cleanup.push(async () => {
          await client.close()
          await transport.close()
          if (cleanupFailed) {
            throw new FileError('MCP_CLOSE_FAILED', 'MCP cleanup failed')
          }
        })
        await client.connect(transport, { timeout: config.timeoutMs })
        clients.push({ client, timeoutMs: config.timeoutMs })
        for (const tool of await discover(client, config.timeoutMs)) {
          if (owners.has(tool.name)) {
            throw new FileError('TOOL_CONFLICT', 'MCP tool names conflict')
          }
          owners.set(tool.name, { client, timeoutMs: config.timeoutMs })
          tools.push(redact(tool, secrets))
        }
      }
      if (this.disposed) {
        throw new FileError('DISPOSED', 'MCP manager disposed')
      }
      return connection
    } catch (error) {
      await connection.close()
      if (error instanceof FileError) {
        throw error
      }
      if (
        (error instanceof ProtocolError && error.code === ErrorCode.RequestTimeout) ||
        (error instanceof Error && error.name === 'TimeoutError')
      ) {
        throw new FileError('MCP_TIMEOUT', 'MCP request timed out')
      }
      throw new FileError('MCP_CONNECT_FAILED', 'MCP connection failed')
    }
  }
  dispose = (): Promise<void> =>
    (this.closing ??= (async () => {
      this.disposed = true
      await this.queue
      await Promise.allSettled(this.pending)
      const results = await Promise.allSettled([...this.connections].map((connection) => connection.close()))
      if (results.some((result) => result.status === 'rejected')) {
        throw new FileError('MCP_CLOSE_FAILED', 'MCP cleanup failed')
      }
    })())
}
