import { EventSchemas, EventType } from '@ag-ui/core'

import type { AdapterOutcome, AgUiEvent } from '../types'

/**
 * A native terminal outcome or an interruption discovered during recovery.
 */
export type TerminalOutcome = AdapterOutcome

/**
 * Validate a value against the AG-UI event schemas.
 *
 * @returns The validated event.
 * @throws A schema validation error for malformed events.
 */
export const parseEvent = (value: unknown): AgUiEvent => {
  return EventSchemas.parse(value)
}

/**
 * Create the manager-owned RUN_STARTED event using SDK session and run IDs.
 */
export const startedEvent = (sessionId: string, runId: string): AgUiEvent => {
  return parseEvent({ runId, threadId: sessionId, type: EventType.RUN_STARTED })
}

/**
 * Map success to RUN_FINISHED and other terminal outcomes to RUN_ERROR.
 */
export const terminalEvent = (sessionId: string, runId: string, outcome: TerminalOutcome): AgUiEvent => {
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
