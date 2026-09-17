import { expect, test } from 'vitest'

import { parseFrame } from './protocol'

test('accepts the native notification emission timestamp', () => {
  expect(
    parseFrame({ emittedAtMs: 1789600000000, method: 'remoteControl/status/changed', params: { status: 'disabled' } })
  ).toEqual({
    kind: 'notification',
    method: 'remoteControl/status/changed',
    params: { status: 'disabled' }
  })
  expect(() => parseFrame({ emittedAtMs: 'invalid', method: 'notice', params: {} })).toThrow()
})
