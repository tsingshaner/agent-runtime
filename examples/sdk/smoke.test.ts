import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { describe, expect, test } from 'vitest'

describe('real Codex smoke opt-in', () => {
  test.each([
    ['', ''],
    ['test-model', ''],
    ['', '1']
  ])('skips without both required environment settings: %j', (model, enabled) => {
    const env = { ...process.env }
    env.CODEX_MODEL = model
    env.RUN_CODEX_SMOKE = enabled
    const output = execFileSync(process.execPath, [fileURLToPath(new URL('./smoke.ts', import.meta.url))], {
      encoding: 'utf8',
      env
    })
    expect(output.trim()).toBe('SKIPPED: real Codex smoke not run')
  })
})
