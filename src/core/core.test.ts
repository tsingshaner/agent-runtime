import { describe } from 'vitest'

import { add } from '@/core'

describe('test core', (test) => {
  test('add function', ({ expect }) => {
    const res = add(1, 2)

    expect(res).toBe(3)
  })
})
