import { defineConfig } from 'nitro'

export default defineConfig({
  plugins: ['./src/lifecycle.ts'],
  preset: 'node-server',
  rolldownConfig: {
    external: [
      '@qingshaner/runtime',
      '@qingshaner/runtime-dsh',
      '@qingshaner/runtime-deepagents',
      '@electric-sql/pglite'
    ]
  },
  serverDir: './src',
  serverEntry: './src/entry.ts',
  // Preserve package-relative database assets, DSH plugins and native SQLite bindings.
  traceDeps: ['@qingshaner/runtime*', '@electric-sql/pglite*']
})
