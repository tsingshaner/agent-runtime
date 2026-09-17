# TanStack AI local client

Start the [local HTTP server](../../apps/server/README.md), create a project and
session through its authenticated API, then run:

```sh
pnpm --filter @internal/tanstack-example start http://127.0.0.1:4310 /absolute/path/http-token SESSION_ID 'your prompt'
```

The CLI displays text and tools, prompts for approval (anything except `approve`
denies), answers input questions, and requests cancellation on Ctrl+C. Secret
questions require a client with masked entry and remain pending in this example.
A token file keeps credentials out of command arguments.

`RuntimeClient.submit` sends one POST. `watch` uses the official
`@tanstack/ai-client` 0.32.0 `fetchServerSentEvents().joinRun()` and
`StreamProcessor`; AG-UI chunks and UI messages use official types. Custom
interaction notifications load the SDK's typed persisted requests before
responding through the HTTP controls. Terminal events remain distinct from
transport/subscription errors.

The official adapter reconnects with GET and `Last-Event-ID`, deduplicates event
IDs, and bounds consecutive stalled reconnects (5, 250 ms delay). A new `watch`
rebuilds messages by replaying the run from the beginning; replace the displayed
messages with that result rather than appending another transcript. Aborting a
subscription leaves its Run active; `cancel` explicitly cancels the Run. An early
transport failure without a received event ID surfaces to the caller; call
`watch(runId)` again, never `submit`, to resubscribe. Cleared history (410) cannot
be replayed. This example keeps no second event parser or chat protocol.

```sh
# Controlled real HTTP + PGlite, no model API or credentials:
pnpm exec vitest run examples/tanstack/client.test.ts
# Explicit real model smoke:
RUN_TANSTACK_SMOKE=1 CODEX_MODEL=gpt-6-astra pnpm --filter @internal/tanstack-example smoke
```

Controlled coverage: GET cursor reconnect, single execution, ordered text and
tools, no duplicated text, one terminal, approve/deny, input and cancellation.
Real smoke results are recorded separately below; untriggered behavior is not
counted as real verification.

On 2026-09-17, Codex 0.153.4 / gpt-6-astra passed the explicit real smoke:
HTTP submission, official TanStack SSE ingestion, ordered text, unique success,
and GET replay with identical message IDs, roles and content. UI `createdAt`
is generated locally on each replay and is deliberately excluded from equality.
Native tools, approval, input, cancellation and network loss were not triggered
in this real smoke (UNVERIFIED); controlled tests exercise those paths, including
cancellation while an approval callback is still waiting. Interaction callbacks
receive an AbortSignal and must use it to close prompts; late answers cannot be
submitted after subscription teardown.
