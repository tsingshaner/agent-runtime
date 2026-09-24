# A2A client example

Uses the official `@a2a-js/sdk` **1.2.0**, A2A **1.0**, and JSON-RPC. Start the local server and create a Project and Session through its REST API first (see [server README](../../apps/server/README.md)).

```sh
pnpm --filter @internal/a2a-example start http://127.0.0.1:4310 /path/to/data/http-token <session-id> 'Your prompt'
pnpm --filter @internal/a2a-example smoke
```

The example discovers the authenticated `/.well-known/agent-card.json`, submits a text message with `contextId = sessionId`, consumes `/a2a` SSE output, and prompts for interaction JSON when input or approval is required. Ctrl+C requests cancellation of this Task only. A cancellation response can still be working; query or subscribe to confirm its terminal state. Do not enter secrets into this basic CLI.

For a new Task, send a user text message without `taskId`; reuse its `messageId` and identical text to recover a lost submission response. Subsequent work in the same session uses a new message ID and creates a new Task/Run. To answer an interaction, send exactly one data part with the existing `taskId`:

```json
{"inputId":"public-input-id","answers":{"question-id":["answer"]}}
```

```json
{"approvalId":"public-approval-id","decision":"approve"}
```

`deny` is also accepted. Batch approvals are sent individually; the Manager waits for the complete batch. Pending IDs and questions are in `Task.status.message.parts[].data`; stale, cross-run and repeated answers are rejected. Responses with uncertain native acknowledgement must not be retried automatically.

`SendMessage` blocks until terminal/input-required unless `configuration.returnImmediately` is true. Both `SendStreamingMessage` and `SubscribeToTask` start with a current Task snapshot, followed by new status/artifact updates; disconnecting does not cancel execution. Terminal tasks reject subscription and further messages. Task IDs differ from Run IDs (`Task.metadata.runId`); task identity and accumulated text persist even after AG-UI events are cleared. Restart marks unfinished tasks failed (`metadata.runStatus = interrupted`) and expires interactions.

This first version requires an existing managed Session as context, supports text work and structured interaction replies, and retains no A2A message history (`history` is empty). Push notifications, task listing, files, reference tasks, protocol extensions, and A2A 0.3 are unsupported. All routes share bearer/Host/Origin checks with REST; JSON-RPC calls require `A2A-Version: 1.0` (the official client supplies it).

The smoke uses the built Nitro server and real HTTP without model credentials. Full execution, interaction, stream/reconnect and persistence are covered using real PGlite and a controlled adapter in `packages/runtime/src/a2a.test.ts`. This does not claim live native interaction coverage.

Protocol references: [A2A specification](https://a2a-protocol.org/latest/specification/), [official TypeScript SDK](https://github.com/a2aproject/a2a-js).


Explicit native protocol acceptance (no hosted credentials):

```sh
RUN_NATIVE_PROTOCOL_SMOKE=1 pnpm --filter @internal/a2a-example smoke:native
```

This launches the built Nitro service, real DSH Harness processes and real tools against a
local deterministic HTTP/SSE model provider. It exercises the official A2A client and the
TanStack example's typed client: input continuation, approved/denied shell effects,
cancellation while waiting for approval, stable Task/Run identity and terminal Task rejection.
The shell effect is confined to a temporary project directory and removed on completion.
Each result is labelled `native-deterministic`; this verifies native protocol integration,
not hosted-model behavior. Without the explicit flag, `node native-smoke.ts` reports `SKIPPED`.
