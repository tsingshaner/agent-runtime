import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { once } from 'node:events'
import { lstat, readdir, readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js'
import type { Knowledge } from '@qingshaner/knowledge'
import type { Mcp, McpConnection } from '@qingshaner/mcp'
import type { Skills } from '@qingshaner/skill'

import { RuntimeError } from './errors'

export interface ResourceSnapshot {
  skillDirectories: string[]
  url: string
  /** Ephemeral local bridge credential; never expose through management responses. */
  token: string
}
export interface ResourceOptions {
  knowledge?: Knowledge
  skills?: Skills
  mcp?: Mcp
}

const skillDigest = async (directory: string): Promise<string> => {
  const hash = createHash('sha256')
  const visit = async (path: string): Promise<void> => {
    const stat = await lstat(path)
    if (stat.isSymbolicLink()) {
      throw new RuntimeError('RESOURCE_PREPARATION_FAILED', 'Skill contains a symlink')
    }
    if (stat.isDirectory()) {
      for (const name of (await readdir(path)).sort()) {
        await visit(join(path, name))
      }
    } else if (stat.isFile()) {
      hash.update(path)
      hash.update(await readFile(path))
    } else {
      throw new RuntimeError('RESOURCE_PREPARATION_FAILED', 'Skill contains an unsupported file')
    }
  }
  await visit(directory)
  return hash.digest('hex')
}

/** One explicit resource set per project, shared by its sessions and closed after drain. */
export class ProjectResources {
  readonly #projects = new Map<
    string,
    Promise<{ fingerprint: string; snapshot: ResourceSnapshot; close: () => Promise<void>; check: () => Promise<void> }>
  >()
  readonly #preparing = new Set<Promise<ResourceSnapshot>>()
  #disposed = false
  constructor(readonly options: ResourceOptions) {}

  prepare = (projectId: string): Promise<ResourceSnapshot> => {
    const pending = this.#prepareProject(projectId).finally(() => this.#preparing.delete(pending))
    this.#preparing.add(pending)
    return pending
  }
  #prepareProject = async (projectId: string): Promise<ResourceSnapshot> => {
    if (this.#disposed) {
      throw new RuntimeError('DISPOSED', 'Resources disposed')
    }
    let root: string | undefined
    try {
      root = await this.options.knowledge?.binding(projectId)
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'NOT_BOUND')) {
        throw new RuntimeError('RESOURCE_PREPARATION_FAILED', 'Knowledge binding unavailable')
      }
    }
    const skills = (await this.options.skills?.enabled(projectId)) ?? []
    const configs = (await this.options.mcp?.enabled(projectId)) ?? []
    const fingerprint = JSON.stringify([
      root,
      await Promise.all(skills.map(async (skill) => [skill.directory, await skillDigest(skill.directory)])),
      configs
    ])
    if (this.#disposed) {
      throw new RuntimeError('DISPOSED', 'Resources disposed')
    }
    let pending = this.#projects.get(projectId)
    if (pending) {
      const prepared = await pending
      if (prepared.fingerprint !== fingerprint) {
        throw new RuntimeError('RESOURCE_UPDATE_REQUIRED', 'Apply project resource changes before running')
      }
      // Validate enabled upstreams before model execution, including already prepared projects.
      await prepared.check()
      return prepared.snapshot
    }
    pending = this.#open(
      projectId,
      !!root,
      skills.map((skill) => skill.directory),
      fingerprint
    ).catch((error: unknown) => {
      this.#projects.delete(projectId)
      throw error
    })
    this.#projects.set(projectId, pending)
    return (await pending).snapshot
  }

  #open = async (projectId: string, knowledge: boolean, skillDirectories: string[], fingerprint: string) => {
    const connection = await this.options.mcp?.connect(projectId)
    try {
      const bridge = await this.#bridge(projectId, knowledge, connection)
      return {
        check: () => connection?.check() ?? Promise.resolve(),
        close: async () => {
          try {
            await bridge.close()
          } finally {
            await connection?.close()
          }
        },
        fingerprint,
        snapshot: { skillDirectories, token: bridge.token, url: bridge.url }
      }
    } catch (error) {
      await connection?.close()
      throw error
    }
  }

  #bridge = async (projectId: string, knowledge: boolean, connection?: McpConnection) => {
    const tools: Tool[] = knowledge
      ? [
          {
            description: 'Search project Markdown knowledge.',
            inputSchema: {
              additionalProperties: false,
              properties: { query: { type: 'string' } },
              required: ['query'],
              type: 'object'
            },
            name: 'knowledge_search'
          },
          {
            description: 'Read a complete current project Markdown document.',
            inputSchema: {
              additionalProperties: false,
              properties: { path: { type: 'string' } },
              required: ['path'],
              type: 'object'
            },
            name: 'knowledge_read'
          }
        ]
      : []
    for (const tool of connection?.tools ?? []) {
      if (tools.some(({ name }) => name === tool.name)) {
        throw new RuntimeError('TOOL_CONFLICT', 'Project resource tools conflict')
      }
      tools.push(tool)
    }
    const calls = new Map<string, (args: Record<string, unknown>) => Promise<CallToolResult>>()
    const library = this.options.knowledge
    if (knowledge && library) {
      calls.set('knowledge_search', async (args) => {
        if (typeof args.query !== 'string') {
          throw new Error('Invalid query')
        }
        return { content: [{ text: JSON.stringify(await library.search(projectId, args.query)), type: 'text' }] }
      })
      calls.set('knowledge_read', async (args) => {
        if (typeof args.path !== 'string') {
          throw new Error('Invalid path')
        }
        return { content: [{ text: await library.read(projectId, args.path), type: 'text' }] }
      })
    }
    if (connection) {
      for (const tool of connection.tools) {
        calls.set(tool.name, (args) => connection.callTool(tool.name, args))
      }
    }
    const token = `Bearer ${randomBytes(32).toString('hex')}`
    const servers = new Set<Server>()
    let host = ''
    const http = createServer((request, response) => {
      void (async () => {
        const supplied = Buffer.from(request.headers.authorization ?? '')
        const expected = Buffer.from(token)
        if (
          request.headers.host !== host ||
          request.headers.origin ||
          supplied.length !== expected.length ||
          !timingSafeEqual(supplied, expected)
        ) {
          response.writeHead(401).end()
          return
        }
        if (request.method !== 'POST') {
          response.writeHead(405).end()
          return
        }
        const chunks: Buffer[] = []
        let size = 0
        for await (const chunk of request) {
          size += chunk.length
          if (size > 1048576) {
            response.writeHead(413).end()
            return
          }
          chunks.push(chunk)
        }
        const body: unknown = JSON.parse(Buffer.concat(chunks).toString())
        const server = new Server({ name: 'project-resources', version: '1.0.0' }, { capabilities: { tools: {} } })
        servers.add(server)
        response.once('close', () => {
          servers.delete(server)
          void server.close().catch(() => {})
        })
        server.setRequestHandler(ListToolsRequestSchema, () => Promise.resolve({ tools }))
        server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
          try {
            const call = calls.get(params.name)
            if (!call) {
              throw new Error('Unknown tool')
            }
            return await call(params.arguments ?? {})
          } catch {
            return { content: [{ text: 'Project resource tool failed', type: 'text' as const }], isError: true }
          }
        })
        const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true, sessionIdGenerator: undefined })
        await server.connect(transport)
        await transport.handleRequest(request, response, body)
      })().catch(() => {
        if (!response.headersSent) {
          response.writeHead(400)
        }
        response.end()
      })
    })
    http.listen(0, '127.0.0.1')
    await once(http, 'listening')
    const address = http.address()
    if (!address || typeof address === 'string') {
      throw new Error('Resource bridge did not listen')
    }
    host = `127.0.0.1:${address.port}`
    return {
      close: async () => {
        try {
          const closed = await Promise.allSettled([...servers].map((server) => server.close()))
          const failure = closed.find((result) => result.status === 'rejected')
          if (failure?.status === 'rejected') {
            throw failure.reason
          }
        } finally {
          http.closeAllConnections()
          await new Promise<void>((resolve) => http.close(() => resolve()))
        }
      },
      token,
      url: `http://${host}/mcp`
    }
  }

  release = async (projectId: string): Promise<void> => {
    const pending = this.#projects.get(projectId)
    if (!pending) {
      return
    }
    try {
      await (await pending).close()
    } finally {
      this.#projects.delete(projectId)
    }
  }
  dispose = async (): Promise<void> => {
    this.#disposed = true
    await Promise.allSettled(this.#preparing)
    await Promise.all([...this.#projects.keys()].map(this.release))
  }
}
