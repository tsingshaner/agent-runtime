import { glob } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { defineConfig, type UserConfig } from 'tsdown'

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

export default defineConfig(async () => {
  const alias = await generateAliases()

  return Promise.all(
    alias.map<UserConfig>(({ replacement, find }) => ({
      cwd: resolve(replacement, '../'),
      dts: {
        tsconfig: resolve(ROOT, 'tsconfig.build.json')
      },
      entry: 'src/index.ts',
      format: 'esm',
      name: find,
      outDir: resolve(replacement, '../dist'),
      tsconfig: resolve(ROOT, 'tsconfig.build.json')
    }))
  )
})
