// cspell:ignore tencentdb
// biome-ignore-all lint/style/useNamingConvention: Official SDK wire field names.
import { MemoryClient } from '@tencentdb-agent-memory/memory-sdk-ts-v2'
import * as v from 'valibot'

const nonBlank = v.pipe(
  v.string(),
  v.check((value) => value.trim().length > 0)
)
const count = v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(200))
const pageSchema = v.strictObject({
  limit: v.optional(count, 50),
  offset: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0)), 0)
})
const optionsSchema = v.strictObject({
  apiKeyEnv: v.pipe(v.string(), v.regex(/^[A-Za-z_][A-Za-z0-9_]*$/)),
  endpoint: v.pipe(
    v.string(),
    v.check((value) => {
      try {
        const url = new URL(value)
        return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash
      } catch {
        return false
      }
    })
  ),
  serviceId: nonBlank,
  timeoutMs: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(120000)), 5000)
})
export type ProjectMemoryOptions = v.InferInput<typeof optionsSchema>
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
const parse = <S extends v.GenericSchema>(schema: S, input: unknown): v.InferOutput<S> => {
  const result = v.safeParse(schema, input)
  if (!result.success) {
    throw new MemoryError('INVALID_INPUT', 'Invalid memory input')
  }
  return result.output
}

/** Fixed-pair official SDK facade; project identity never depends on runtime kind. */
export class ProjectMemory {
  private readonly options: v.InferOutput<typeof optionsSchema>
  constructor(options: ProjectMemoryOptions) {
    this.options = parse(optionsSchema, options)
  }
  private client = (projectId: string, sessionId?: string): MemoryClient => {
    parse(nonBlank, projectId)
    if (sessionId !== undefined) {
      parse(nonBlank, sessionId)
    }
    const apiKey = process.env[this.options.apiKeyEnv]
    if (!apiKey) {
      throw new MemoryError('MISSING_CREDENTIAL', 'Memory credential is unavailable')
    }
    return new MemoryClient({
      agentId: 'agent-runtime',
      apiKey,
      endpoint: this.options.endpoint,
      rejectUnauthorized: true,
      serviceId: this.options.serviceId,
      sessionId,
      teamId: projectId,
      timeout: this.options.timeoutMs,
      userId: 'local-user'
    })
  }
  private request = async <T>(operation: () => Promise<T>): Promise<T> => {
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
      v.strictObject({
        assistant: v.string(),
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
      client = this.client(value.projectId, value.sessionId)
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
      const acceptedIds = parse(v.pipe(v.array(nonBlank), v.length(2)), result.accepted_ids)
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
    return this.request(() => this.client(projectId).queryConversation(input))
  }
  deleteConversations = (projectId: string, ids: string[]) => {
    const message_ids = parse(v.pipe(v.array(nonBlank), v.minLength(1), v.maxLength(5000)), ids)
    return this.request(() => this.client(projectId).deleteConversation({ message_ids }))
  }
  query = (projectId: string, page: { limit?: number; offset?: number } = {}) => {
    const input = parse(pageSchema, page)
    return this.request(() => this.client(projectId).queryAtomic(input))
  }
  search = (projectId: string, query: string, limit = 20) => {
    parse(nonBlank, query)
    parse(count, limit)
    return this.request(() => this.client(projectId).searchAtomic({ limit, query }))
  }
  update = (projectId: string, id: string, content: string) => {
    parse(nonBlank, id)
    parse(nonBlank, content)
    return this.request(() => this.client(projectId).updateAtomic({ content, id }))
  }
  delete = (projectId: string, ids: string[]) => {
    parse(v.pipe(v.array(nonBlank), v.minLength(1), v.maxLength(5000)), ids)
    return this.request(() => this.client(projectId).deleteAtomic({ ids }))
  }
  readCore = (projectId: string) => this.request(() => this.client(projectId).readCore())
  writeCore = (projectId: string, content: string) => {
    parse(v.string(), content)
    return this.request(() => this.client(projectId).writeCore({ content }))
  }
  recall = (
    projectId: string,
    query: string,
    options: { limit?: number; maxChars?: number } = {}
  ): Promise<{ context: string }> => {
    parse(nonBlank, query)
    const { limit, maxChars } = parse(
      v.strictObject({
        limit: v.optional(count, 5),
        maxChars: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(32000)), 6000)
      }),
      options
    )
    return this.request(async () => {
      const client = this.client(projectId)
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
