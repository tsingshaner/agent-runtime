import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const version = '0.153.4'
if (execFileSync('codex', ['--version'], { encoding: 'utf8' }).trim() !== `codex-cli ${version}`) {
  throw new Error(`Protocol generation requires codex-cli ${version}`)
}
const source = mkdtempSync(join(tmpdir(), `agent-runtime-protocol-${version}-`))
const destination = fileURLToPath(new URL('../src/schemas/', import.meta.url))
const roots = [
  'InitializeParams',
  'InitializeResponse',
  ...[
    'ThreadStartParams',
    'ThreadStartResponse',
    'ThreadResumeParams',
    'ThreadResumeResponse',
    'TurnStartParams',
    'TurnStartResponse',
    'TurnInterruptParams',
    'TurnInterruptResponse',
    'TurnStartedNotification',
    'TurnCompletedNotification',
    'ItemStartedNotification',
    'ItemCompletedNotification',
    'AgentMessageDeltaNotification',
    'CommandExecutionOutputDeltaNotification',
    'FileChangeOutputDeltaNotification',
    'CommandExecutionRequestApprovalParams',
    'CommandExecutionRequestApprovalResponse',
    'FileChangeRequestApprovalParams',
    'FileChangeRequestApprovalResponse',
    'ToolRequestUserInputResponse',
    'McpServerElicitationRequestResponse',
    'PermissionsRequestApprovalResponse',
    'ServerRequestResolvedNotification',
    'ErrorNotification'
  ].map((name) => `v2/${name}`)
]
try {
  execFileSync('codex', ['app-server', 'generate-ts', '--out', source], { stdio: 'inherit' })
  const visited = new Set()
  function copy(name) {
    const file = resolve(source, `${name}.ts`)
    if (visited.has(file)) {
      return
    }
    visited.add(file)
    const target = join(destination, `${name}.ts`)
    mkdirSync(dirname(target), { recursive: true })
    copyFileSync(file, target)
    for (const match of readFileSync(file, 'utf8').matchAll(/from "(\.[^"]+)"/g)) {
      copy(join(dirname(name), match[1]))
    }
  }
  rmSync(destination, { force: true, recursive: true })
  roots.forEach(copy)
  process.stdout.write(`Pinned codex-cli ${version}: copied ${visited.size} protocol files\n`)
} finally {
  rmSync(source, { force: true, recursive: true })
}
