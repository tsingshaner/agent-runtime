import { definePlugin } from 'nitro'

import { configuredService } from './main.ts'

export default definePlugin(async (app) => {
  const service = await configuredService()
  const stop = () => {
    void service.close().catch(() => {
      process.exitCode = 1
    })
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  app.hooks.hook('close', async () => {
    process.off('SIGINT', stop)
    process.off('SIGTERM', stop)
    await service.close()
  })
})
