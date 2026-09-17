<!-- cspell:ignore langgraph HITL -->

# Deep Agents feasibility probe (#13)

Uses real `createDeepAgent`, LangGraph interrupt/resume and the official persistent
`SqliteSaver`. Only the chat model is a deterministic fixture; no model credentials
or hosted provider calls are used. Hosted-model integration is **UNVERIFIED**.
This is a probe, not the production adapter.

Pinned direct versions: deepagents 1.13.5, langchain 1.5.11, @langchain/core 1.2.11,
@langchain/langgraph 1.4.15, @langchain/langgraph-checkpoint-sqlite 1.0.4, zod 4.6.5.
The SQLite saver needs the `better-sqlite3` native build (lockfile: 12.11.1).

From the repository root, after installing dependencies:

```sh
node_modules/.bin/vitest run --project @internal/probe-deepagents
node examples/probe-deepagents/probe.ts batch /tmp/deepagents-batch
node examples/probe-deepagents/probe.ts pause /tmp/deepagents-pause
node examples/probe-deepagents/probe.ts inspect /tmp/deepagents-pause
node examples/probe-deepagents/probe.ts new /tmp/deepagents-pause
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
| Mixed approve/reject batch | **BLOCKED**: approved effects 0, rejected effects 0; rejection reaches model |
| All-approved control | Both effects occur exactly once (2 total) |
| Pause, exit, reopen | Same interrupt ID and two actions survive in another process; no effects |
| New run on stale interrupt | `unsafe_resume`, no model invocation or effects |
| Cancel after tool starts | Signal stops cooperative timer before write, tool settles, effects 0 |
| New run after cancellation | `unsafe_resume`, no replay |
| New run after completed control | Accepted; previous two effects remain exactly two |

The mixed-batch result contradicts Spec #10 / ADR 0005. The pinned LangChain HITL
middleware computes `hasRejectedToolCalls`, omits approved calls when any decision
rejects, and jumps back to the model. This probe reports
`mixed_batch_unsupported`; passing probe tests **does not mean #13 acceptance is
satisfied**. We neither patch upstream nor replay the dropped approved calls.
The all-approved control proves the effect tool itself works.

A new run is admitted only from an existing checkpoint with no next nodes,
interrupts or task errors. Pending work is preserved and refused; no automatic
`Command({ resume: ... })` is sent after reopening. Same-process batch completion
uses one native Command with both decisions. `durability: 'sync'` ensures graph
checkpoints finish before subsequent steps; it does not make arbitrary external
effects transactional. Crash-after-effect-before-checkpoint and non-cooperative
tools remain **UNVERIFIED**. This probe does not claim exactly-once effects or
safe resumption of unfinished nodes. Production must retain the Manager's
interrupted-run gate in addition to inspecting the native checkpoint.

Primary references:

- [Deep Agents HITL](https://docs.langchain.com/oss/javascript/deepagents/human-in-the-loop)
- [LangGraph interrupts and re-execution](https://docs.langchain.com/oss/javascript/langgraph/interrupts)
- [Official SQLite saver](https://github.com/langchain-ai/langgraphjs/tree/main/libs/checkpoint-sqlite)
- [Pinned HITL implementation](https://unpkg.com/langchain@1.5.11/dist/agents/middleware/hitl.js)
