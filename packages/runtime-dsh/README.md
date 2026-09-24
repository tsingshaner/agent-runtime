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
