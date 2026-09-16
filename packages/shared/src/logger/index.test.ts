import { describe } from 'vitest'

import { getLogger } from '.'

describe('should export logger', (test) => {
  test('should create a logger instance', ({ expect }) => {
    const logger = getLogger('runtime')

    expect(logger).toBeDefined()
  })
})
