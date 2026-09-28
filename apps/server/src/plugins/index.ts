import { definePlugin } from 'nitro'

import { cleanup } from '../infra/shutdown'

export default definePlugin((app) => {
  app.hooks.hook('close', cleanup)
})
