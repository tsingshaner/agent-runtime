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

`RuntimeClient.api` is inferred from `@qingshaner/runtime-contract` and uses oRPC
`OpenAPILink`. `submit` sends one POST; `watch` decodes oRPC SSE and feeds AG-UI
chunks into the official TanStack `StreamProcessor`. Custom notifications load
typed persisted approval/input requests before responding through the API.

Only subscriptions reconnect: up to 5 attempts with a 250 ms delay and the last
received SSE ID. Premature EOF and network errors can reconnect; oRPC errors
(including cleared history / `GONE`) surface immediately. Transport failures never
become fabricated Run terminal events. A new `watch` replays the run; replace the
displayed messages instead of appending another transcript. Aborting a subscription
leaves the Run active; `cancel` explicitly cancels it.

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

Before the oRPC migration, on 2026-09-17, Codex 0.153.4 / gpt-6-astra passed the explicit real smoke:
HTTP submission, official TanStack SSE ingestion, ordered text, unique success,
and GET replay with identical message IDs, roles and content. UI `createdAt`
is generated locally on each replay and is deliberately excluded from equality.
Native tools, approval, input, cancellation and network loss were not triggered
in this real smoke (UNVERIFIED); controlled tests exercise those paths, including
cancellation while an approval callback is still waiting. Interaction callbacks
receive an AbortSignal and must use it to close prompts; late answers cannot be
submitted after subscription teardown.

The 2026-09-23 oRPC migration is verified by controlled HTTP tests; the historical
real-model smoke above has not been rerun for the new transport.
