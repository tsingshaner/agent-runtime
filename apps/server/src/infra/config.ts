import { resolve } from 'node:path'

import { getLogger } from '@internal/shared'
import { loadConfig } from 'c12'
import { useRuntimeConfig } from 'nitro/runtime-config'
import * as z from 'zod/mini'

const configSchema = z.object({
  runtime: z.object({
    dataDir: z.string().check(z.minLength(1))
  })
  // auth: z.object({
  //   github: z.object({
  //     clientId: z.string().check(z.minLength(1)),
  //     clientSecret: z.string().check(z.minLength(1))
  //   }),

  //   secret: z.string().check(z.minLength(32))
  // }),

  // baseURL: z.url(),

  // database: z.discriminatedUnion('driver', [
  //   z.object({
  //     dataDir: z.optional(z.string().check(z.minLength(1))),
  //     driver: z.literal('pglite')
  //   }),
  //   z.object({
  //     driver: z.literal('postgres'),
  //     url: z.url()
  //   })
  // ]),

  // store: z.discriminatedUnion('driver', [
  //   z.object({
  //     base: z.string().check(z.minLength(1)),
  //     driver: z.literal('fs-lite')
  //   }),
  //   z.object({
  //     base: z.string().check(z.minLength(1)),
  //     driver: z.literal('upstash'),
  //     scanCount: z.optional(z.number()),
  //     ttl: z.optional(z.number())
  //   })
  // ])
})

let $config: Promise<z.output<typeof configSchema>>

const readConfig = async () => {
  const logger = getLogger(['api', 'config'])
  const config =
    import.meta.prerender || !import.meta.nitro
      ? (
          await loadConfig({
            configFile: 'nitro.config',
            cwd: resolve(import.meta.dirname, import.meta.prerender ? '../../..' : '../..'),
            dotenv: {
              fileName: ['.env.example', '.env']
            },
            giget: false,
            packageJson: false,
            rcFile: false
          })
        ).config.runtimeConfig
      : // biome-ignore lint/correctness/useHookAtTopLevel: not react hooks
        useRuntimeConfig()

  const result = z.safeParse(configSchema, config)

  if (!result.success) {
    // cspell:ignore treeify
    const error = new Error(`Invalid config: ${JSON.stringify(z.treeifyError(result.error))}`)
    logger.fatal(error)

    throw error
  }

  result.data.runtime.dataDir = resolve(result.data.runtime.dataDir)

  logger.info('Config loaded successfully', { config: result.data })

  return result.data
}

export const getConfig = () => {
  if (!$config) {
    $config = readConfig()
  }

  return $config
}
