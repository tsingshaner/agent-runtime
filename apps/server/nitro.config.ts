import { defineConfig } from 'nitro'

export default defineConfig({
  modules: [
    (nitro) => {
      if (!nitro.options.dev) {
        return
      }
      // Signals reach the dev parent, not the worker that owns the data directory.
      let stopping = false
      const stop = () => {
        if (stopping) {
          return
        }
        stopping = true
        void nitro.close().then(
          () => process.exit(0),
          () => process.exit(1)
        )
      }
      process.on('SIGINT', stop)
      process.on('SIGTERM', stop)
      nitro.hooks.hook('close', () => {
        // Keep signal handlers during shutdown so the watcher does not re-raise the signal.
        if (stopping) {
          return
        }
        process.off('SIGINT', stop)
        process.off('SIGTERM', stop)
      })
    }
  ],
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
  serverEntry: './src/index.ts',
  // Preserve package-relative database assets, DSH plugins and native SQLite bindings.
  traceDeps: ['@qingshaner/runtime*', '@electric-sql/pglite*']
})
