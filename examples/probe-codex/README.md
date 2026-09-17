# Codex project isolation probe (#12)

Pinned CLI: **0.153.4**, Node.js 24. The probe reuses the repository's app-server
transport and uses the official MCP SDK 1.30.0 for a disposable tool server.

```sh
pnpm --filter @internal/probe-codex smoke
RUN_CODEX_ISOLATION=1 CODEX_MODEL=gpt-6-astra pnpm --filter @internal/probe-codex smoke
```

Without explicit opt-in the executable reports SKIPPED. Live mode requires
existing Codex authentication in `CODEX_AUTH_HOME/auth.json` (defaults to
`CODEX_HOME`, then `~/.codex`). Authentication is copied with mode 0600 into a
private temporary directory. The original config and authentication are not
modified. The model must be explicit. No experimental API opt-in is used.

Each of two projects owns one app-server process and creates two native threads
on that connection. Synthetic global skill/MCP canaries live under a disposable
HOME. Each application CODEX_HOME contains only its project MCP configuration;
`features.apps = false` also prevents the built-in `codex_apps` connector from
appearing. Skills are selected with `skills/extraRoots/set`, enumerated and
explicitly enabled/disabled with `skills/config/write` in the application home.
Only the selected project's skill may remain enabled. Disabled skill metadata
can remain visible in the management inventory; this is a capability whitelist,
not filesystem confinement against hostile arbitrary shell commands.

The model receives a named skill, reads its random secret, and must call the
project's MCP tool with that secret. The expected secret is never in the user
prompt. Each tool appends its real invocation to an audit file. The probe then
changes the first project's skill directory and MCP connection, reloads MCP,
and runs the **same native thread** again. All three actual invocations must
match exactly. Merely listing resources or getting a successful model turn does
not pass. MCP approvals are accepted only for the three disposable fixture
servers; other server requests are rejected.

Finally, all owned app-server processes are closed through the transport's
bounded termination path and temporary state is removed, including on failure.
The 120-second turn deadline and native error/exit notifications reject the
probe. This does not claim OS-level isolation or implement the production
resource manager.

The real CLI emits `emittedAtMs` on notifications. The existing strict transport
previously rejected it; this change accepts a safe integer only on notifications
and adds a regression test (including invalid metadata rejection).

Primary reference: [pinned app-server protocol](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/app-server/README.md).

Recorded 2026-09-17: **PASS**, CLI 0.153.4, Node 24.11.0, explicitly selected
`gpt-6-astra`, `experimentalApi: false`. Two project processes, two threads per
process, three exact skill-secret/MCP invocations, and same-thread next-turn
resource replacement all passed. No global configuration was edited.
