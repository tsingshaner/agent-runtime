import { definePlugin } from 'nitro'

import { configuredService } from '../infra/service'
import { cleanup } from '../infra/shutdown'

export default definePlugin(async (app) => {
  app.hooks.hook('close', cleanup)
  await configuredService()
})
