import { defineConfig } from 'nitro'

export default defineConfig({
  plugins: ['./src/lifecycle.ts'],
  preset: 'node-server',
  rolldownConfig: { external: ['@qingshaner/runtime', '@electric-sql/pglite'] },
  serverDir: './src',
  serverEntry: './src/entry.ts',
  // Keep package-relative database assets and migrations alongside their modules.
  traceDeps: ['@qingshaner/runtime*', '@electric-sql/pglite*']
})
