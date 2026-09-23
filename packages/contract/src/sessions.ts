import { openapi } from '@orpc/openapi'
import * as z from 'zod/mini'

import { base, byId, done, idBody, idQuery, query, withBody } from './base'
import * as s from './schemas'

const sessionsBase = base.meta(openapi({ tags: ['Sessions'] }))
const runsBase = base.meta(openapi({ tags: ['Runs'] }))

export const sessions = {
  archive: sessionsBase
    .meta(
      openapi({
        description:
          'Archives a session without deleting native history. Sessions with an active Run cannot be archived.',
        method: 'POST',
        operationId: 'archiveSession',
        path: '/sessions/{id}/archive',
        summary: 'Archive an idle session'
      })
    )
    .input(byId)
    .output(done),
  create: sessionsBase
    .meta(
      openapi({
        description:
          'Creates a session bound to one project and runtime with an explicit model and existing working directory. Returns only after native creation and public indexing succeed.',
        method: 'POST',
        operationId: 'createSession',
        path: '/sessions',
        summary: 'Create a session'
      })
    )
    .input(withBody(s.sessionCreate))
    .output(s.session),
  get: sessionsBase
    .meta(
      openapi({
        description: 'Returns persisted session metadata, native identity and the active Run ID when present.',
        method: 'GET',
        operationId: 'getSession',
        path: '/sessions/{id}',
        summary: 'Get a session'
      })
    )
    .input(byId)
    .output(s.session),
  list: sessionsBase
    .meta(
      openapi({
        description:
          'Lists sessions with optional project, runtime and archived filters plus cursor pagination. Archived sessions are excluded by default.',
        method: 'GET',
        operationId: 'listSessions',
        path: '/sessions',
        summary: 'List sessions'
      })
    )
    .input(
      query(
        z.strictObject({
          ...s.page.shape,
          archived: z.optional(z.boolean()),
          projectId: z.optional(s.text),
          runtime: z.optional(s.text)
        })
      )
    )
    .output(s.paged(s.session)),
  resume: sessionsBase
    .meta(
      openapi({
        description:
          'Loads the recorded native session context without submitting a new Run. Missing native history is reported rather than replaced with a new session.',
        method: 'POST',
        operationId: 'resumeSession',
        path: '/sessions/{id}/resume',
        summary: 'Resume native session context'
      })
    )
    .input(byId)
    .output(s.session),
  run: runsBase
    .meta(
      openapi({
        description:
          'Returns public Run and session IDs while execution continues in the background. Only one Run may be active per session. Reusing requestId with identical input returns the original Run; different input with that requestId is rejected.',
        method: 'POST',
        operationId: 'submitSessionRun',
        path: '/sessions/{id}/runs',
        summary: 'Submit a Run'
      })
    )
    .input(idBody(z.strictObject({ requestId: z.optional(s.text), text: s.text })))
    .output(z.object({ runId: s.text, sessionId: s.text })),
  runs: runsBase
    .meta(
      openapi({
        description: 'Returns persisted Run history for the session using cursor pagination.',
        method: 'GET',
        operationId: 'listSessionRuns',
        path: '/sessions/{id}/runs',
        summary: 'List session Runs'
      })
    )
    .input(idQuery(s.page))
    .output(s.paged(s.run)),
  unarchive: sessionsBase
    .meta(
      openapi({
        description:
          'Makes an archived session available for future Runs without starting execution or changing its native identity.',
        method: 'POST',
        operationId: 'unarchiveSession',
        path: '/sessions/{id}/unarchive',
        summary: 'Unarchive a session'
      })
    )
    .input(byId)
    .output(done)
}
