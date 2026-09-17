<!-- cspell:ignore langgraph HITL -->

# Deep Agents feasibility probe (#13)

Uses real `createDeepAgent`, LangGraph interrupt/resume and the official persistent
`SqliteSaver`. The batch approval policy uses the official `createMiddleware` extension hooks.
Only the chat model is a deterministic fixture; no model credentials
or hosted provider calls are used. Hosted-model integration is **UNVERIFIED**.
This is a probe, not the production adapter.

Pinned direct versions: deepagents 1.13.5, langchain 1.5.11, @langchain/core 1.2.11,
@langchain/langgraph 1.4.15, @langchain/langgraph-checkpoint-sqlite 1.0.4, zod 4.6.5.
The SQLite saver needs the `better-sqlite3` native build (lockfile: 12.11.1).

From the repository root, after installing dependencies:

```sh
node_modules/.bin/vitest run --project @internal/probe-deepagents
node examples/probe-deepagents/probe.ts native /tmp/deepagents-native
node examples/probe-deepagents/probe.ts batch /tmp/deepagents-batch
node examples/probe-deepagents/probe.ts pause /tmp/deepagents-pause
node examples/probe-deepagents/probe.ts inspect /tmp/deepagents-pause
node examples/probe-deepagents/probe.ts new /tmp/deepagents-pause
node examples/probe-deepagents/probe.ts resume /tmp/deepagents-pause
node examples/probe-deepagents/probe.ts inspect /tmp/deepagents-pause
node examples/probe-deepagents/probe.ts cancel /tmp/deepagents-cancel
node examples/probe-deepagents/probe.ts new /tmp/deepagents-cancel
node examples/probe-deepagents/probe.ts approve /tmp/deepagents-approved
node examples/probe-deepagents/probe.ts new /tmp/deepagents-approved
```

Use fresh directories per scenario. Each process prints JSON evidence, including
its PID and actual effects read from `effects.jsonl`; `checkpoint.sqlite` retains
the native state. No memory saver or hand-built graph substitutes are involved.

| Scenario | Observed result |
| --- | --- |
| Built-in `interruptOn` mixed batch (`native`) | **UNSUPPORTED**: approved effects 0, rejected effects 0; rejection reaches model |
| Official middleware extension mixed batch (`batch`) | Approved effects 1, rejected effects 0; rejection reaches model |
| Explicit resume in a new process | Approved effects 1, rejected effects 0; decision batch present in SQLite checkpoint history |
| Reused tool-call IDs in a later run | New interrupt; rejecting both leaves previous effects unchanged |
| Invalid / missing / extra decisions or unsupported decision fields | Validation error before tools, 0 effects; new run refused |
| Repeated resume after completion | Refused: no pending batch; effects unchanged |
| All-approved control | Both effects occur exactly once (2 total) |
| Pause, exit, reopen | Same interrupt ID and two actions survive in another process; no effects |
| New run on stale interrupt | `unsafe_resume`, no model invocation or effects |
| Cancel after tool starts | Signal stops cooperative timer before write, tool settles, effects 0 |
| New run after cancellation | `unsafe_resume`, no replay |
| New run after completed control | Accepted; previous two effects remain exactly two |

The built-in mixed-batch result contradicts Spec #10 / ADR 0005. The pinned
LangChain HITL middleware computes `hasRejectedToolCalls`, omits approved calls
when any decision rejects, and jumps back to the model. `npm view langchain
version` returned 1.5.11 on 2026-09-17, so upgrading to the current release does
not solve this. The `native` control retains this reproducible upstream result.

The extension preserves ADR 0005: `afterModel` issues one native `interrupt` for
all protected calls, validates one positional decision per action, and returns
the decision batch into graph state. `durability: 'sync'` persists that state
before tools execute. `wrapToolCall` invokes the original handler once for each
approved call, or returns an error `ToolMessage` for a rejected call without
invoking its handler. It does not mutate/replay model calls or patch upstream.
The probe supports only `record_effect`; this is not a general adapter policy.
Every model response replaces the batch (including with an empty batch), so a
later call with a reused ID cannot inherit an earlier approval. Missing or
duplicate action IDs fail closed; strict validation rejects malformed batches.
Decisions are positional, so identical `approve` values for distinct actions
are valid, while extra ID fields masquerading as duplicate decisions are not.

`resume` is an explicit operator action for the currently pending batch in this
single-session probe, not automatic recovery. It accepts an optional JSON array
of decisions as its third argument; default is approve then reject. `inspect`
prints nonempty approval batches from persisted checkpoint history. Passing this
probe demonstrates the issue's mixed-batch condition through a supported custom
extension; it does **not** mean built-in `interruptOn` was fixed.

A new run is admitted only from an existing checkpoint with no next nodes,
interrupts or task errors. Pending work is preserved and refused; no automatic
`Command({ resume: ... })` is sent after reopening. Both same-process and explicit cross-process batch completion
use one native Command with both decisions. `durability: 'sync'` ensures graph
checkpoints finish before subsequent steps; it does not make arbitrary external
effects transactional. Crash-after-effect-before-checkpoint and non-cooperative
tools remain **UNVERIFIED**. This probe does not claim exactly-once effects or
safe resumption of unfinished nodes. Production must retain the Manager's
interrupted-run gate in addition to inspecting the native checkpoint.

Primary references:

- [Official custom middleware hooks and state](https://docs.langchain.com/oss/javascript/langchain/middleware/custom)
- [Deep Agents HITL](https://docs.langchain.com/oss/javascript/deepagents/human-in-the-loop)
- [LangGraph interrupts and re-execution](https://docs.langchain.com/oss/javascript/langgraph/interrupts)
- [Official SQLite saver](https://github.com/langchain-ai/langgraphjs/tree/main/libs/checkpoint-sqlite)
- [Pinned HITL implementation](https://unpkg.com/langchain@1.5.11/dist/agents/middleware/hitl.js)
