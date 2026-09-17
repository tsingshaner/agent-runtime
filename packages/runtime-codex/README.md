# @qingshaner/runtime-codex

<p align="center">
<a href="https://jsr.io/@qingshaner/runtime-codex"><img src="https://jsr.io/badges/@qingshaner/runtime-codex" alt="JSR package" /></a>
<a href="https://www.npmjs.com/@qingshaner/runtime-codex" target="_blank"><img src="https://img.shields.io/npm/v/@qingshaner/runtime-codex" alt="NPM Version" /></a>
<img alt="LICENSE" src="https://img.shields.io/github/license/tsingshaner/agent-runtime">
<a href="https://github.com/tsingshaner/agent-runtime/actions/workflows/ci.yml"><img src="https://github.com/tsingshaner/agent-runtime/actions/workflows/ci.yml/badge.svg" alt="unit-test" /></a>
<a href="https://biomejs.dev"><img alt="Linted with Biome" src="https://img.shields.io/badge/Linted_with-Biome-60a5fa?style=flat&logo=biome"></a>
<a href="https://biomejs.dev" target="_blank"><img alt="Static Badge" src="https://img.shields.io/badge/Formatted_with-Biome-60a5fa?style=flat&logo=biome"></a>
</p>

Agent runtime by codex

## Protocol baseline

The checked-in protocol types come from **codex-cli 0.153.4**, without
experimental APIs. This is the only verified version. Builds use these files
and do not invoke or require an installed Codex CLI.

To regenerate the consumed types and their recursive imports, install exactly
that CLI version and run `pnpm --filter @qingshaner/runtime-codex gen:schema`.
The script rejects other versions and preserves the generated headers.

The internal transport uses newline-delimited JSON over piped stdio, a 15-second
request timeout, and no automatic retries. An incoming frame or queued outgoing
data exceeding 8 MiB closes the transport with `STREAM_OVERFLOW`; every session
sharing that app-server is affected. Frame consumers run synchronously; the
adapter owns its separate bounded async notification queue.

Shutdown closes stdin, waits 2 seconds, sends SIGTERM, waits another 2 seconds,
then sends SIGKILL if needed, and always waits for the process to close. The
`shutdownTimeoutMs` option overrides each grace period. Stderr retains only a
private 16 KiB tail and is never included in public errors or logs. Process
errors report only a safe status, exit code, and signal.

## SDK usage

Requires Node.js 24, an authenticated Codex CLI, and an explicitly selected model.
Importing the package or constructing CodexRuntime starts no process. The first
create/resume operation lazily starts one owned app-server per project. Sessions in a project share that process;
different projects have separate processes and native homes.

```ts
import { CodexRuntime } from '@qingshaner/runtime-codex'

const runtime = new CodexRuntime({ dataDir: './.agent-runtime/codex' })
// Register runtime in RuntimeManager.open({ dataDir, runtimes: [runtime] }).
// Pass model explicitly to manager.createSession({ projectId, cwd, runtime: 'codex', model }).
```

Constructor options: optional `model` default for legacy/direct adapter callers, `dataDir`, `codexHome`, `executable` with
`command` and `args`, `requestTimeoutMs`, and `shutdownTimeoutMs`. Authentication
copies only `auth.json` from `codexHome` (or `CODEX_HOME` / `~/.codex`) into
each owned home; never put credentials in session options. User configuration
is never modified. Native state defaults to `~/.local/share/agent-runtime/codex`;
set `dataDir` alongside your manager's data directory to own their lifetime together.
Only an explicitly resumed legacy thread's rollout is copied from the source home;
other CLI history is not imported. Keep this directory across service restarts.
An empty native thread is not durable until history is written by Codex.

Each child has an isolated `HOME` and `CODEX_HOME`. Before creating or resuming
a thread, the adapter clears extra skill roots, disables discovered skills and
MCP servers, and disables apps. Resource bindings will extend this empty baseline.
Configuration discovery is refreshed for later sessions. Manager sessions require a top-level `model`; typed
`CodexSessionOptions` accept only `sandbox` (`workspace-write` default or `read-only`), and `approvalPolicy`
(`on-request` default or `never`). Native threads always use `ephemeral: false`.
Input is text only. Command and file-change approvals support one-time approve
or deny. Tool questions use `listPendingInputs` / `respondInput`; unsupported
interactive requests are declined or fail explicitly.

Use RuntimeManager's public session/run IDs, not native IDs. Disconnecting a
subscription does not cancel generation while the host lives. `cancel()` sends
turn/interrupt without killing the shared child; wait for a terminal run event.
Process failure affects active runs in that process; a later explicit resume
can start a fresh process and recover a saved native thread.

The pinned schema and controlled-peer tests establish the protocol baseline;
real authentication/model behavior additionally requires the opt-in smoke.
From the repository run `pnpm smoke:codex` for an explicit skipped result, or
`RUN_CODEX_SMOKE=1 CODEX_MODEL=your-model pnpm smoke:codex` in an interactive
terminal. Follow approve/deny and cancel prompts. A scenario that was not
triggered is reported UNVERIFIED, never passed. Run this after any CLI upgrade
before claiming compatibility. Builds and CI never invoke login or a model.

Persistent prompts, outputs and approvals can contain sensitive information;
see the runtime package documentation for ownership locks, event retention,
manual stale-lock recovery, and `clearRunEvents`.

The no-model project isolation check is opt-in:
`RUN_CODEX_PROJECT_SMOKE=1 pnpm exec vitest run packages/runtime-codex/test/projects.test.ts`.
It uses the installed CLI, injects fixture history without a model turn, and verifies
resource isolation, persistence and targeted legacy resume. It needs no model credentials.
