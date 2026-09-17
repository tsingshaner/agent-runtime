# DSH persistent continuation probe (#11)

Run from the repository root with Node.js 24 and the locked workspace dependencies:

```sh
pnpm --filter @internal/probe-dsh probe
pnpm exec vitest run examples/probe-dsh/probe.test.ts
```

The default run uses the **real official SDK and Harness**, paired at
`0.1.5-rc.2`, with the official `sdk-minimal` profile. Only the model HTTP
response is a deterministic local SSE fixture. The SDK creates and runs a
session, closes its process, and starts a different process against the same
isolated Harness home. No upstream source is patched.

The control plugin resumes with `ctx.agents.resume({ resumeSessionId })`.
The SDK's `session/prompt` only owns sessions it created, so resumed execution
uses the official `agent.followup(createUserMessage(...))` and `whenIdle()`.
It does not insert a session into the SDK's private map or create a replacement
with the same name. The public controller lives on a separate ephemeral
loopback HTTP port and requires a random bearer token; browser Origins are
rejected. The plugin and token are confined to the child environment.

Assertions verify:

- First process actually exits before the second starts; both eventually exit.
- Native ID, creation time and header survive (the loader adds the canonical
  `delegationDepth: 0` default); the complete prior event prefix and derived
  model messages are unchanged.
- Resuming alone sends no new model request. A new explicit prompt produces
  the second successful turn, and its request contains the original user marker
  and assistant response.
- A nonexistent native session fails without publishing a new session; invalid
  authentication fails.
- An observational preload forwards stdout unchanged and checks every emitted
  line is JSON-RPC. The audit records only frame counts and a boolean, not wire
  contents. The control channel never writes stdout.

The temporary home, fixture and owned runtimes are cleaned up. Operations are
bounded; no model credentials or upstream stderr are printed. This is a probe,
not a production adapter: one idle resumed session, text prompts, and no
approval, cancellation or interrupted-tool recovery contract.

For a real hosted model run, explicitly supply `DEEPSEEK_API_KEY` through your
shell environment and select a model:

```sh
DSH_PROBE_MODEL=deepseek-v4-flash node --env-file=.env.local examples/probe-dsh/probe.ts --external
```

This mode uses `https://api.deepseek.com`, never a user-global Harness home.
Missing credentials yield `UNVERIFIED`; hosted responses must complete both
turns. The exact model HTTP request-count check belongs to the local fixture.

## Recorded result

2026-09-17, Node.js 24.11.0: deterministic probe and public Vitest entry **PASS**,
including distinct runtime PIDs, retained history, exactly two model requests,
missing-session rejection, authentication rejection and clean SDK stdout.
Hosted DeepSeek **PASS** with explicitly selected `deepseek-v4-flash`, using
Node's `--env-file=.env.local` to load the supplied credential without printing
it. Both real hosted turns completed across the original process's confirmed
exit and a different process's native restoration; history, authentication,
missing-session rejection and stdout assertions also passed.

This passes #11's clean-exit persistent continuation gate. Interrupted in-flight
recovery remains **UNVERIFIED**; the result does not establish safety for
resuming pending tool operations or finalize other lifecycle contracts.

The implementation uses the published `0.1.5-rc.2` package declarations and
runtime code; primary upstream references:
[SDK client](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/sdk/client),
[SDK server](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/sdk/jsonrpc-server),
[agent registry](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/core/agent).
