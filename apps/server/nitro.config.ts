import { defineConfig } from 'nitro'

export default defineConfig({
  plugins: ['./src/lifecycle.ts'],
  preset: 'node-server',
  rolldownConfig: {},
  serverDir: './src',
  serverEntry: './src/entry.ts'
})
