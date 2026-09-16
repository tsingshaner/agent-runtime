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
