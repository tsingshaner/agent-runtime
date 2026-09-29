import { defineConfig } from 'nitro'

export default defineConfig({
  modules: [
    (nitro) => {
      if (!nitro.options.dev) {
        nitro.options.ignore.push('**/openapi.html')
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
  publicAssets: [{ baseURL: '/assets', dir: '../web/dist/assets' }],
  rolldownConfig: {
    external: [
      '@qingshaner/runtime',
      '@qingshaner/runtime-dsh',
      '@qingshaner/runtime-deepagents',
      '@electric-sql/pglite'
    ]
  },
  runtimeConfig: {
    runtime: {
      dataDir: process.env.NITRO_RUNTIME_DATA_DIR ?? process.env.RUNTIME_DATA_DIR ?? '.agent-runtime'
    }
  },
  serverAssets: [{ baseName: 'web', dir: '../web/dist', pattern: 'index.html' }],
  serverDir: './src',
  serverEntry: './src/index.ts',
  // Preserve package-relative database assets, DSH plugins and native SQLite bindings.
  traceDeps: ['@qingshaner/runtime*', '@electric-sql/pglite*']
})
