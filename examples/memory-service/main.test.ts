// biome-ignore-all lint/style/useNamingConvention: Explicit smoke opt-in environment variable.
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

import { expect, test } from 'vitest'

test('real installation and Gateway smoke require explicit opt-in', () => {
  const output = execFileSync(process.execPath, [join(import.meta.dirname, 'main.ts')], {
    encoding: 'utf8',
    env: { ...process.env, RUN_MEMORY_SERVICE_SMOKE: '' }
  })
  expect(output).toBe('SKIPPED: set RUN_MEMORY_SERVICE_SMOKE=1 to install and run the real MemoryCore\n')
})
