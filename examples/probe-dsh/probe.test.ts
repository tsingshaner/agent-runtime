import { describe, expect, test } from 'vitest'

import { probe } from './probe'

describe('DSH persistent continuation probe', () => {
  test('restores native identity and history in a new process before continuing', async () => {
    const result = await probe()
    expect(result.framework).toBe('PASS')
    if (result.framework !== 'PASS') {
      throw new Error('Framework not verified')
    }
    expect(result.hostedModel).toBe('UNVERIFIED')
    expect(result.processIds[0]).not.toBe(result.processIds[1])
    expect(result.modelRequests).toBe(2)
    expect(result.historyRetained).toBe(true)
    expect(result.missingRejected).toBe(true)
    expect(result.unauthorizedRejected).toBe(true)
    expect(result.stdoutClean).toBe(true)
  }, 120_000)
})
