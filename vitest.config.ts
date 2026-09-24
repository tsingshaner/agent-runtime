import { glob } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig(async () => {
  const ROOT = import.meta.dirname

  const generateAliases = async () => {
    const packageJsonPaths = await Array.fromAsync(
      glob(['apps/*/package.json', 'packages/*/package.json', 'examples/*/package.json'], {
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
      coverage: {
        exclude: ['packages/runtime-codex/src/schemas/**', '**/*.test.ts'],
        include: ['packages/*/src/**/*.ts']
      },
      projects: alias.flatMap(({ find, replacement }) => {
        const include = [
          `${replacement}/**/*.{test,spec}.?(c|m)ts?(x)`,
          `${dirname(replacement)}/test/**/*.test.ts`,
          `${dirname(replacement)}/*.test.ts`
        ]
        const light =
          find === '@qingshaner/runtime'
            ? [`${replacement}/ag-ui/**/*.test.ts`, `${replacement}/lock.test.ts`]
            : find === '@qingshaner/runtime-codex'
              ? [`${replacement}/events.test.ts`]
              : []
        // Separate groups prevent database startup from competing with short native RPC deadlines.
        const native = [
          '@qingshaner/runtime-codex',
          '@qingshaner/runtime-dsh',
          '@qingshaner/runtime-deepagents'
        ].includes(find)
        const groupOrder = find === '@qingshaner/runtime' ? 1 : native ? 2 : 0
        const groups = [
          { exclude: [...configDefaults.exclude, ...light], groupOrder, include, name: find },
          ...(light.length > 0
            ? [{ exclude: configDefaults.exclude, groupOrder: 0, include: light, name: `${find}:light` }]
            : [])
        ]
        return groups.map(({ exclude, groupOrder, include, name }) => ({
          test: {
            ...configDefaults,
            alias,
            exclude,
            fileParallelism: groupOrder !== 2,
            include,
            maxWorkers: groupOrder === 0 ? 4 : groupOrder === 1 ? 2 : 1,
            name,
            root: ROOT,
            sequence: { groupOrder },
            typecheck: {
              checker: 'tsc',
              enabled: true,
              ignoreSourceErrors: false,
              only: false,
              tsconfig: resolve(ROOT, 'tsconfig.build.json')
            }
          }
        }))
      })
    }
  }
})
