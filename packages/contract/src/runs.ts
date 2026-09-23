// cspell:ignore AGUI
import { type AGUIEvent, EventSchemas } from '@ag-ui/core'
import { asyncIteratorObject, type Schema } from '@orpc/contract'
import { openapi } from '@orpc/openapi'
import * as z from 'zod/mini'

import { base, byId, done, idQuery, itemParams } from './base'
import * as s from './schemas'

const inputsBase = base.meta(openapi({ tags: ['Inputs'] }))
const approvalsBase = base.meta(openapi({ tags: ['Approvals'] }))
const runsBase = base.meta(openapi({ tags: ['Runs'] }))

// Keep the public event stream type independent of AG-UI's inferred Zod 3 types.
export interface EventStream extends AsyncIterator<AGUIEvent, void, void> {
  [Symbol.asyncIterator](): EventStream
}
const eventStream: Schema<AsyncIteratorObject<unknown, void, void>, EventStream> = asyncIteratorObject(
  EventSchemas,
  z.void()
)

export const runs = {
  answer: inputsBase
    .meta(
      openapi({
        description:
          'Submits question answers to the pending input request within the existing Run. Stale or already answered requests are rejected.',
        method: 'POST',
        operationId: 'answerRunInput',
        path: '/runs/{id}/inputs/{item}',
        summary: 'Answer a pending input request'
      })
    )
    .input(z.object({ body: z.strictObject({ answers: s.answers }), params: itemParams }))
    .output(done),
  approvals: approvalsBase
    .meta(
      openapi({
        description:
          'Returns persisted outstanding approvals for the Run, including individual decisions waiting for their batch to complete.',
        method: 'GET',
        operationId: 'listRunApprovals',
        path: '/runs/{id}/approvals',
        summary: 'List outstanding approvals'
      })
    )
    .input(byId)
    .output(z.array(s.approval)),
  approve: approvalsBase
    .meta(
      openapi({
        description:
          'Records an individual approval decision. A batch is submitted to the runtime only after all its decisions are collected; stale or duplicate responses are rejected.',
        method: 'POST',
        operationId: 'respondRunApproval',
        path: '/runs/{id}/approvals/{item}',
        summary: 'Approve or deny an operation'
      })
    )
    .input(z.object({ body: z.strictObject({ decision: s.decision }), params: itemParams }))
    .output(done),
  cancel: runsBase
    .meta(
      openapi({
        description:
          'Requests cancellation of the target Run without affecting other sessions. A successful response does not itself confirm a terminal state; query or subscribe to the Run to observe completion.',
        method: 'POST',
        operationId: 'cancelRun',
        path: '/runs/{id}/cancel',
        summary: 'Request Run cancellation'
      })
    )
    .input(byId)
    .output(done),
  clearEvents: runsBase
    .meta(
      openapi({
        description:
          'Removes event history for a terminal Run while retaining its index and last sequence. Subsequent subscriptions return HTTP 410 (GONE).',
        method: 'DELETE',
        operationId: 'clearRunEvents',
        path: '/runs/{id}/events',
        summary: 'Clear terminal Run event history'
      })
    )
    .input(byId)
    .output(done),
  events: runsBase
    .meta(
      openapi({
        description:
          'Streams AG-UI events through oRPC SSE with durable run-local sequence IDs. Last-Event-ID takes precedence over the exclusive afterSequence cursor. Disconnecting stops only the subscription, not the Run. Cleared history returns HTTP 410 (GONE); stream errors remain distinct from Run terminal events.',
        method: 'GET',
        operationId: 'subscribeRunEvents',
        path: '/runs/{id}/events',
        summary: 'Subscribe to Run events'
      })
    )
    .input(idQuery(z.strictObject({ afterSequence: z.optional(s.count) })))
    .output(eventStream),
  get: runsBase
    .meta(
      openapi({
        description: 'Returns persisted Run status, identity, event sequence and safe execution or memory errors.',
        method: 'GET',
        operationId: 'getRun',
        path: '/runs/{id}',
        summary: 'Get a Run'
      })
    )
    .input(byId)
    .output(s.run),
  inputs: inputsBase
    .meta(
      openapi({
        description:
          'Returns persisted pending questions so a disconnected client can resume interaction within the existing Run.',
        method: 'GET',
        operationId: 'listRunInputs',
        path: '/runs/{id}/inputs',
        summary: 'List pending input requests'
      })
    )
    .input(byId)
    .output(z.array(s.inputRequest)),
  memoryWrite: base
    .meta(
      openapi({
        description:
          'Returns the independent memory write record for the Run, or null when no record exists. A successful Run does not imply that memory was accepted.',
        method: 'GET',
        operationId: 'getRunMemoryWrite',
        path: '/runs/{id}/memory-write',
        summary: 'Get a Run memory write',
        tags: ['Memory']
      })
    )
    .input(byId)
    .output(z.nullable(s.memoryWrite))
}
