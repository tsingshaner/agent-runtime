// biome-ignore-all lint/style/useNamingConvention: Native environment variable names.
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { expect, test } from 'vitest'

test('does not launch Codex without explicit opt-in', () => {
  const output = execFileSync(process.execPath, [fileURLToPath(new URL('./main.ts', import.meta.url))], {
    encoding: 'utf8',
    env: { ...process.env, CODEX_EXECUTABLE: '/does-not-exist', RUN_CODEX_ISOLATION: '' }
  })
  expect(output).toBe('SKIPPED: Codex isolation probe not enabled\n')
})
