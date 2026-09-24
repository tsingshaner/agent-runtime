// biome-ignore-all lint/suspicious/noConsole: Standalone packaging verification.
// biome-ignore-all lint/suspicious/noMisplacedAssertion: Standalone smoke assertions.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { glob, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'

const execute = promisify(execFile)
const root = resolve(import.meta.dirname, '../..')
const directory = await mkdtemp(join(tmpdir(), 'runtime-consumer-'))
try {
  const internal = JSON.parse(await readFile(join(root, 'packages/shared/package.json'), 'utf8'))
  assert.equal(internal.private, true, 'Internal shared package must not be publishable')
  const dependencies: Record<string, string> = {}
  for await (const path of glob('packages/*/package.json', { cwd: root })) {
    const cwd = dirname(join(root, path))
    const manifest = JSON.parse(await readFile(join(root, path), 'utf8'))
    if (manifest.private) {
      continue
    }
    const tarball = join(directory, `${basename(cwd)}.tgz`)
    await execute('pnpm', ['pack', '--out', tarball], { cwd, timeout: 60000 })
    dependencies[manifest.name] = `file:${tarball}`
  }
  for (const name of [
    'runtime',
    'runtime-codex',
    'runtime-dsh',
    'runtime-deepagents',
    'memory',
    'knowledge',
    'skill',
    'mcp'
  ]) {
    assert.ok(dependencies[`@qingshaner/${name}`], `Missing public package ${name}`)
  }
  await writeFile(
    join(directory, 'package.json'),
    JSON.stringify({ dependencies, name: 'external-runtime-consumer', private: true, type: 'module' })
  )
  // Resolve public workspace references to these exact archives, including transitive references.
  await writeFile(
    join(directory, 'pnpm-workspace.yaml'),
    `overrides: ${JSON.stringify(dependencies)}\nallowBuilds:\n  better-sqlite3: true\n`
  )
  await execute('pnpm', ['install', '--no-frozen-lockfile'], {
    cwd: directory,
    maxBuffer: 8 * 1024 * 1024,
    timeout: 180000
  })
  await writeFile(
    join(directory, 'verify.mjs'),
    `import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { readdir } from 'node:fs/promises'
const original = new Map()
for (const key of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  original.set(key, childProcess[key])
  childProcess[key] = () => { throw new Error('Import/construction must not start processes') }
}
syncBuiltinESMExports()
for (const name of ${JSON.stringify(Object.keys(dependencies))}) await import(name)
const { RuntimeManager } = await import('@qingshaner/runtime')
const { CodexRuntime } = await import('@qingshaner/runtime-codex')
const { DshRuntime } = await import('@qingshaner/runtime-dsh')
const { DeepAgentsRuntime } = await import('@qingshaner/runtime-deepagents')
const runtimes = [new CodexRuntime({dataDir: './native/codex'}), new DshRuntime({dataDir: './native/dsh'}), new DeepAgentsRuntime({dataDir: './native/deepagents'})]
assert.equal((await readdir('.')).includes('native'), false)
const first = await RuntimeManager.open({dataDir: './state', runtimes})
await first.createProject({id: 'outside-workspace', name: 'Archive consumer'})
await first.dispose()
const second = await RuntimeManager.open({dataDir: './state', runtimes: []})
try { assert.equal((await second.getProject('outside-workspace')).name, 'Archive consumer') }
finally { await second.dispose() }
for (const [key, value] of original) childProcess[key] = value
syncBuiltinESMExports()
console.log('VERIFIED: archive imports, inert constructors, migrations and persistent reopen outside workspace')
`
  )
  const result = await execute(process.execPath, ['verify.mjs'], { cwd: directory, timeout: 60000 })
  console.log(result.stdout.trim())
} finally {
  await rm(directory, { force: true, recursive: true })
}
