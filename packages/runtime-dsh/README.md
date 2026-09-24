<!-- cspell:ignore SIGSTOP -->
# DSH runtime

`DshRuntime({ dataDir, apiKeyEnv?: 'DEEPSEEK_API_KEY', baseURL? })` implements
`RuntimeAdapter` using the official SDK/Harness pinned together at `0.1.5-rc.2`.
Register it with `RuntimeManager` and create a `runtime: 'dsh'` session with an
explicit model. Import and construction perform no I/O.

Each session owns one lazy Harness process, isolated HOME/DSH home and bearer
protected loopback control channel. The official `sdk-minimal` profile starts
the process; a Cordis plugin uses the official Agent registry create/resume,
followup and native stream events. SDK stdio remains reserved for JSON-RPC.
The Manager owns durable public IDs, events and terminal states.

Native history stays in `dataDir`. A persisted active marker refuses unsafe
continuation after a lost execution; it never creates replacement history or
replays a prompt. Missing history fails explicitly. The process environment
contains only the selected provider credential and required runtime settings.
The profile is a tool runtime, not a file-access security sandbox.

Run the credential-free real-Harness check:

```sh
pnpm vitest run packages/runtime-dsh/src/runtime.test.ts
```

This verifies native bash execution and tool results, streaming, clean process
exit followed by persistent continuation, provider-error sanitization, and
missing-history rejection. Hosted model verification is separately recorded;
a local model HTTP fixture is not evidence of hosted-model acceptance.

Native tool calls wait at the official pre-execute waterfall for a Manager
approval; denial happens before the tool body. `ask_user_question` uses the
native user-question service and remains a separate input request. Plan-review
intents are rejected rather than translated into generic input authorization.
Control disconnect aborts pending interactions. Replies are never retried.
Cancellation first requests native cancellation and waits for confirmed idle;
timeout closes only the target session process and records `interrupted`.

`control.test.ts` verifies denial/no side effects, native input, cancellation
isolation, SIGKILL interruption, and SIGSTOP cancellation fallback using real
owned Harness processes. `native-control.test.ts` verifies bearer rejection,
channel disconnect and process release. All use a local model fixture.

Project resources reuse `ProjectResources`; the official DSH MCP client talks
to its authenticated bridge, so Knowledge and both upstream MCP transports use
the existing resource managers. The official filesystem Skill provider receives
only links to enabled managed directories, with default roots and watching off.
Missing/ambiguous native skill catalogs fail before model execution. Changes
close idle session processes and explicitly resume their original histories.
The Manager drains active runs and keeps approval/input/cancel available first.

`resources.test.ts` verifies actual Knowledge/Skill reads, stdio and HTTP MCP
calls, ordinary tool errors, project/global isolation, drain/rebuild, disabled
skill rejection and release of the old MCP child.

Hosted acceptance on 2026-09-24: PASS with `deepseek-v4-flash`, official Harness
and SDK `0.1.5-rc.2`. The formal adapter executed Skill, Knowledge, real stdio/HTTP
MCP and native user input; a new process resumed the same session and recalled
the two resource secrets and chosen answer. Run explicitly (never in CI):

```sh
DSH_LIVE=1 DSH_MODEL=deepseek-v4-flash node --env-file=.env.local \
  node_modules/vitest/vitest.mjs run packages/runtime-dsh/src/live.test.ts
```

Hosted refusal/cancellation timing is not claimed: those failure paths are
verified using the real Harness with controlled model replies and process faults.
