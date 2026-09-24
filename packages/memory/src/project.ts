// cspell:ignore tencentdb
// biome-ignore-all lint/style/useNamingConvention: Official SDK wire field names.
import { MemoryClient } from '@tencentdb-agent-memory/memory-sdk-ts-v2'
import * as z from 'zod/mini'

const nonBlank = z.string().check(z.refine((value) => value.trim().length > 0))
const count = z.int().check(z.minimum(1), z.maximum(200))
const pageSchema = z.strictObject({
  limit: z.prefault(count, 50),
  offset: z.prefault(z.int().check(z.minimum(0)), 0)
})
const optionsSchema = z.strictObject({
  apiKeyEnv: z.string().check(z.regex(/^[A-Za-z_][A-Za-z0-9_]*$/)),
  endpoint: z.string().check(
    z.refine((value) => {
      try {
        const url = new URL(value)
        return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash
      } catch {
        return false
      }
    })
  ),
  serviceId: nonBlank,
  timeoutMs: z.prefault(z.int().check(z.minimum(1), z.maximum(120000)), 5000)
})
export type ProjectMemoryOptions = z.input<typeof optionsSchema>
export interface MemoryConversation {
  projectId: string
  sessionId: string
  runId: string
  user: string
  assistant: string
}
export type MemoryReceipt = Pick<MemoryConversation, 'projectId' | 'sessionId' | 'runId'> &
  (
    | { status: 'accepted'; acceptedIds: string[] }
    | { status: 'failed' | 'unknown'; error: { code: string; message: string } }
  )
export class MemoryError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'MemoryError'
  }
}
const parse = <S extends z.ZodMiniType>(schema: S, input: unknown): z.output<S> => {
  const result = z.safeParse(schema, input)
  if (!result.success) {
    throw new MemoryError('INVALID_INPUT', 'Invalid memory input')
  }
  return result.data
}

/** Fixed-pair official SDK facade; project identity never depends on runtime kind. */
export class ProjectMemory {
  readonly #options: z.output<typeof optionsSchema>
  constructor(options: ProjectMemoryOptions) {
    this.#options = parse(optionsSchema, options)
  }
  #client = (projectId: string, sessionId?: string): MemoryClient => {
    parse(nonBlank, projectId)
    if (sessionId !== undefined) {
      parse(nonBlank, sessionId)
    }
    const apiKey = process.env[this.#options.apiKeyEnv]
    if (!apiKey) {
      throw new MemoryError('MISSING_CREDENTIAL', 'Memory credential is unavailable')
    }
    return new MemoryClient({
      agentId: 'agent-runtime',
      apiKey,
      endpoint: this.#options.endpoint,
      rejectUnauthorized: true,
      serviceId: this.#options.serviceId,
      sessionId,
      teamId: projectId,
      timeout: this.#options.timeoutMs,
      userId: 'local-user'
    })
  }
  #request = async <T>(operation: () => Promise<T>): Promise<T> => {
    try {
      return await operation()
    } catch (error) {
      if (error instanceof MemoryError) {
        throw error
      }
      throw new MemoryError('MEMORY_UNAVAILABLE', 'Memory service request failed')
    }
  }
  write = async (input: MemoryConversation): Promise<MemoryReceipt> => {
    const value = parse(
      z.strictObject({
        assistant: z.string(),
        projectId: nonBlank,
        runId: nonBlank,
        sessionId: nonBlank,
        user: nonBlank
      }),
      input
    )
    const source = { projectId: value.projectId, runId: value.runId, sessionId: value.sessionId }
    let client: MemoryClient
    try {
      client = this.#client(value.projectId, value.sessionId)
    } catch {
      return {
        ...source,
        error: { code: 'MISSING_CREDENTIAL', message: 'Memory credential is unavailable' },
        status: 'failed'
      }
    }
    try {
      const result = await client.addConversation({
        messages: [
          { content: value.user, id: `${value.runId}:user`, role: 'user' },
          { content: value.assistant, id: `${value.runId}:assistant`, role: 'assistant' }
        ]
      })
      const acceptedIds = parse(z.array(nonBlank).check(z.length(2)), result.accepted_ids)
      return { ...source, acceptedIds, status: 'accepted' }
    } catch {
      return {
        ...source,
        error: {
          code: 'MEMORY_WRITE_UNCERTAIN',
          message: 'Memory write was not confirmed; do not retry automatically'
        },
        status: 'unknown'
      }
    }
  }
  conversations = (projectId: string, page: { limit?: number; offset?: number } = {}) => {
    const input = parse(pageSchema, page)
    return this.#request(() => this.#client(projectId).queryConversation(input))
  }
  deleteConversations = (projectId: string, ids: string[]) => {
    const message_ids = parse(z.array(nonBlank).check(z.minLength(1), z.maxLength(5000)), ids)
    return this.#request(() => this.#client(projectId).deleteConversation({ message_ids }))
  }
  query = (projectId: string, page: { limit?: number; offset?: number } = {}) => {
    const input = parse(pageSchema, page)
    return this.#request(() => this.#client(projectId).queryAtomic(input))
  }
  search = (projectId: string, query: string, limit = 20) => {
    parse(nonBlank, query)
    parse(count, limit)
    return this.#request(() => this.#client(projectId).searchAtomic({ limit, query }))
  }
  update = (projectId: string, id: string, content: string) => {
    parse(nonBlank, id)
    parse(nonBlank, content)
    return this.#request(() => this.#client(projectId).updateAtomic({ content, id }))
  }
  delete = (projectId: string, ids: string[]) => {
    parse(z.array(nonBlank).check(z.minLength(1), z.maxLength(5000)), ids)
    return this.#request(() => this.#client(projectId).deleteAtomic({ ids }))
  }
  readCore = (projectId: string) => this.#request(() => this.#client(projectId).readCore())
  writeCore = (projectId: string, content: string) => {
    parse(z.string(), content)
    return this.#request(() => this.#client(projectId).writeCore({ content }))
  }
  recall = (
    projectId: string,
    query: string,
    options: { limit?: number; maxChars?: number } = {}
  ): Promise<{ context: string }> => {
    parse(nonBlank, query)
    const { limit, maxChars } = parse(
      z.strictObject({
        limit: z.prefault(count, 5),
        maxChars: z.prefault(z.int().check(z.minimum(1), z.maximum(32000)), 6000)
      }),
      options
    )
    return this.#request(async () => {
      const client = this.#client(projectId)
      const [atomic, core, scenarios] = await Promise.all([
        client.searchAtomic({ limit, query }),
        client.readCore(),
        client.listScenarios()
      ])
      const content = [
        core.content ?? '',
        ...atomic.items.slice(0, limit).map((item) => item.content),
        ...scenarios.entries.slice(0, limit).map((entry) => entry.summary ?? entry.path)
      ].filter(Boolean)
      return { context: content.join('\n\n').slice(0, maxChars) }
    })
  }
}
