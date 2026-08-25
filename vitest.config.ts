import { resolve } from 'node:path'

import { defineConfig } from 'vitest/config'

const ROOT = import.meta.dirname

export default defineConfig({
  resolve: {
    alias: {
      '@': resolve(ROOT, 'src')
    }
  },
  test: {
    coverage: {
      include: ['src/', '!src/**/*.{test,spec}.ts']
    },
    root: ROOT
  }
})
