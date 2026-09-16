import { EventType } from '@ag-ui/core'
import { describe, expect, test } from 'vitest'

import { parseEvent, terminalEvent } from '.'

describe('terminalEvent', () => {
  test('represents cancellation as an error, not successful completion', () => {
    expect(terminalEvent('s1', 'r1', { status: 'cancelled' })).toMatchObject({
      code: 'CANCELLED',
      type: EventType.RUN_ERROR
    })
  })

  test('rejects malformed event input', () => {
    expect(() => parseEvent({ delta: 12, type: 'TEXT_MESSAGE_CONTENT' })).toThrow()
  })
})
