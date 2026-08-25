import { defineConfig } from 'tsdown'

export default defineConfig({
  alias: {
    '@': 'src'
  },
  dts: {
    cjsReexport: true,
    oxc: true
  },
  entry: 'src/index.ts',
  format: ['cjs', 'esm'],
  tsconfig: '.config/tsconfig.app.json'
})
