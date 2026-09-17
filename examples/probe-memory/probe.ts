// cspell:ignore tencentdb
import { MemoryClient } from '@tencentdb-agent-memory/memory-sdk-ts-v2'

export function projectClient(endpoint: string, projectId: string, sessionId?: string) {
  return new MemoryClient({
    agentId: 'agent-runtime',
    apiKey: 'probe-only-token',
    endpoint,
    serviceId: 'probe-memory',
    sessionId,
    teamId: projectId,
    timeout: 5000,
    userId: 'local-user'
  })
}

export async function writeOnce(client: MemoryClient, runId: string, user: string, assistant: string) {
  try {
    const result = await client.addConversation({
      messages: [
        { content: user, id: `${runId}:user`, role: 'user' },
        { content: assistant, id: `${runId}:assistant`, role: 'assistant' }
      ]
    })
    return { result, runId, status: 'accepted' as const }
  } catch {
    // No deduplication guarantee: a lost response may follow a committed write.
    return { runId, status: 'unknown' as const }
  }
}

/** Project recall intentionally spans sessions and runtime sources. */
export async function recallProject(client: MemoryClient, query: string) {
  const project = client.withIsolation({ sessionId: null })
  const [atomic, core, scenarios] = await Promise.all([
    project.searchAtomic({ limit: 5, query }),
    project.readCore(),
    project.listScenarios()
  ])
  return { atomic: atomic.items, core: core.content, scenarios: scenarios.entries.slice(0, 5) }
}
