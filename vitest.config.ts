import { glob } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig(async () => {
  const ROOT = import.meta.dirname

  const generateAliases = async () => {
    const packageJsonPaths = await Array.fromAsync(
      glob(['apps/*/package.json', 'packages/*/package.json'], {
        cwd: ROOT
      })
    )

    return Promise.all(
      packageJsonPaths.map(async (packageJsonPath) => {
        const packageJson = await import(fileURLToPath(new URL(packageJsonPath, import.meta.url)), {
          with: { type: 'json' }
        })

        return {
          find: packageJson.default.name,
          replacement: resolve(ROOT, dirname(packageJsonPath), 'src')
        }
      })
    )
  }

  const alias = await generateAliases()

  return {
    test: {
      projects: alias.map(({ find, replacement }) => ({
        test: {
          name: find,
          ...configDefaults,
          alias,
          include: [`${replacement}/**/*.{test,spec}.?(c|m)ts?(x)`],
          root: ROOT,
          typecheck: {
            checker: 'tsc',
            enabled: true,
            ignoreSourceErrors: false,
            only: false,
            tsconfig: fileURLToPath(new URL('tsconfig.build.json', ROOT))
          }
        }
      }))
    }
  }
})
