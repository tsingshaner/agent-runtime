import { EventSchemas, EventType } from '@ag-ui/core'

import type { AdapterOutcome, AgUiEvent, RuntimeFault } from '../types'

export type TerminalOutcome = AdapterOutcome | { status: 'interrupted'; error: RuntimeFault }

export function parseEvent(value: unknown): AgUiEvent {
  return EventSchemas.parse(value)
}

export function startedEvent(sessionId: string, runId: string): AgUiEvent {
  return parseEvent({ runId, threadId: sessionId, type: EventType.RUN_STARTED })
}

export function terminalEvent(sessionId: string, runId: string, outcome: TerminalOutcome): AgUiEvent {
  if (outcome.status === 'succeeded') {
    return parseEvent({ runId, threadId: sessionId, type: EventType.RUN_FINISHED })
  }

  const defaults = {
    cancelled: { code: 'CANCELLED', message: 'Run cancelled' },
    failed: { code: 'RUN_FAILED', message: 'Run failed' },
    interrupted: { code: 'INTERRUPTED', message: 'Run interrupted' }
  }[outcome.status]

  return parseEvent({
    code: outcome.error?.code ?? defaults.code,
    message: outcome.error?.message ?? defaults.message,
    runId,
    threadId: sessionId,
    type: EventType.RUN_ERROR
  })
}
