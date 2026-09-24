import { resolve } from 'node:path'

import { defineConfig, type UserConfig } from 'tsdown'

const ROOT = import.meta.dirname
const packages = [
  ['contract', '@qingshaner/runtime-contract'],
  ['runtime', '@qingshaner/runtime'],
  ['memory', '@qingshaner/memory'],
  ['knowledge', '@qingshaner/knowledge'],
  ['skill', '@qingshaner/skill'],
  ['mcp', '@qingshaner/mcp'],
  ['shared', '@internal/shared'],
  ['runtime-codex', '@qingshaner/runtime-codex'],
  ['runtime-deepagents', '@qingshaner/runtime-deepagents']
] as const
const alias = Object.fromEntries(
  packages.map(([directory, name]) => [name, resolve(ROOT, 'packages', directory, 'src')])
)

export default defineConfig(
  packages.map<UserConfig>(([directory, name]) => ({
    alias,
    cwd: resolve(ROOT, 'packages', directory),
    deps: {
      alwaysBundle: ['@internal/shared'],
      neverBundle: [
        '@ag-ui/core',
        /^@langchain\//,
        'deepagents',
        'langchain',
        /^@a2a-js\/sdk/,
        /^@orpc\//,
        '@electric-sql/pglite',
        '@logtape/logtape',
        '@qingshaner/utility',
        'drizzle-orm',
        'es-toolkit',
        /^zod(?:\/|$)/,
        'yaml',
        /^@modelcontextprotocol\/sdk/,
        '@tencentdb-agent-memory/memory-sdk-ts-v2'
      ]
    },
    dts: {
      tsconfig: resolve(ROOT, 'tsconfig.build.json')
    },
    entry: directory === 'shared' ? ['src/index.ts', 'src/files.ts'] : 'src/index.ts',
    format: 'esm',
    name,
    outDir: 'dist',
    tsconfig: resolve(ROOT, 'tsconfig.build.json')
  }))
)
