# Local runtime HTTP service (Nitro + oRPC)

Run `pnpm --filter @internal/server start` to build and launch the Nitro Node server. `RUNTIME_DATA_DIR` defaults to
`.agent-runtime`; `PORT` defaults to 4310. The listener binds 127.0.0.1 only.
Read the generated bearer token from `http-token` in that data directory (mode
0600); send it as `Authorization: Bearer <token>`, never in a URL. Nitro is the only HTTP listener;
there is no programmatic `startServer` entry point. SIGINT/SIGTERM close all owned adapters,
project resource bridges, subscriptions, storage and the owned MemoryCore process.

Sessions select `codex`, `dsh`, or `deepagents`. All three adapters are registered lazily;
service startup does not start a model or native runtime process. Each has a persistent
subdirectory beneath `RUNTIME_DATA_DIR`. Codex uses the configured local identity;
DSH reads `DEEPSEEK_API_KEY` and optional `DSH_BASE_URL`; Deep Agents reads
`OPENAI_API_KEY` (override the environment variable name with `DEEPAGENTS_API_KEY_ENV`)
and optional `DEEPAGENTS_BASE_URL`. Credentials stay in environment variables, not session options.
Every session requires an explicit provider-compatible model. Sessions keep their original
runtime when resumed, and all runtimes use the same project resources and memory provider.

Contracts live in the browser-safe `@qingshaner/runtime-contract` workspace package.
Nitro 3.0.260903-beta and oRPC 2.0.0-beta.36 are pinned to the reference implementation.
`GET /spec.json` serves generated OpenAPI JSON behind the same bearer/Host/Origin checks.
Use `OpenAPILink(contract, { origin, headers })` and `createORPCClient` for typed REST calls;
see `examples/tanstack/client.ts`. There is no separate RPC endpoint or docs UI.

All request bodies use JSON (maximum 1 MiB). Creation of a session requires explicit `model`,
`runtime`, `projectId`, and existing `cwd`. Routes delegate to the SDK:

- `GET/POST /projects`, `GET/PATCH /projects/:id`
- `GET/POST /sessions`, `GET /sessions/:id`
- `POST /sessions/:id/resume`, `/archive`, `/unarchive`
- `GET/POST /sessions/:id/runs` (POST accepts `text` and optional `requestId`)
- `GET /runs/:id`, `POST /runs/:id/cancel`
- `GET /runs/:id/approvals`, `POST /runs/:id/approvals/:approvalId` with `decision`
- `GET /runs/:id/inputs`, `POST /runs/:id/inputs/:inputId` with `answers`
- `GET/DELETE /runs/:id/events`
- `GET /health` (authenticated)

Lists accept `limit` and `cursor`; sessions also accept `projectId`, `runtime`
and `archived`. SSE data is a standard AG-UI event; each SSE `id` is its durable
run-local sequence. Reconnect using `Last-Event-ID` or `afterSequence` (exclusive).
Disconnecting only stops that subscriber. Cleared history returns 410; stream
failures after headers use an SSE `error` event with a safe code, not a fabricated
Run terminal event. Errors use oRPC JSON (`defined`, `code`, `message`, optional `data`), replacing the
old `{ code }` response. State conflicts retain the SDK code in `data.code`;
validation/not-found/cleared-history errors use `BAD_REQUEST`/`NOT_FOUND`/`GONE`.
Errors omit raw native diagnostics and request contents. Input and output schemas
validate every route. SSE is encoded by oRPC: `message` carries AG-UI data,
`error` carries an oRPC error, and `close` ends the transport. Consumers should use
OpenAPILink to distinguish errors from AG-UI events; no second AG-UI route is maintained.

Normal tests exercise the production Fetch handler and real PGlite with controlled adapters,
without opening the main HTTP listener or calling a model. Cross-runtime tests verify
isolated cancellation/process failure, unconfirmed memory writes that do not delay success,
shutdown, persisted queries after restart and expired input rejection. Native engine behavior
is verified separately by each adapter's tests and explicit smoke commands.
All HTTP smoke scripts launch the built Nitro server.
Explicit real smoke: `RUN_CODEX_SMOKE=1 CODEX_MODEL=<model> pnpm --filter @internal/server smoke`.
Before the oRPC migration, on 2026-09-17, Codex 0.153.4 / gpt-6-astra passed real submission, text SSE,
unique success and cursor replay. Native approval/input/cancellation were not
triggered (UNVERIFIED); controlled Fetch-boundary tests cover those routes.


Resource routes (same bearer authentication):

- `GET/POST /skills`, `GET/DELETE /skills/:id`, `GET/PATCH /skills/:id/file`
- `GET/POST /mcp`, `GET/PATCH/DELETE /mcp/:id`, `POST /mcp/:id/probe`
- `GET/POST/DELETE /projects/:id/knowledge/binding`
- `GET/POST/PATCH/DELETE /projects/:id/knowledge/documents`, `GET /projects/:id/knowledge/search`
- `GET /projects/:id/skills` and `/mcp`; `POST/DELETE` either with `/:resourceId`
- `POST /projects/:id/resources` to reapply external changes
- `GET /projects/:id/memory`, `/memory/search`, `/memory/conversations`, `/memory/core`
- `PATCH /projects/:id/memory/:memoryId` and `/memory/core`; `DELETE /memory` or `/memory/conversations` with `ids`
- `GET /runs/:id/memory-write`, `GET /projects/:id/memory-writes`
- `GET /memory-core`, `POST /memory-core/install`, `/start`, `/stop`

Bindings drain affected runs before reconfiguration. Shared Skill/MCP edits gate
all projects until existing runs drain and configuration is reapplied. Source
Skill directories are copied on import and preserved on deletion. Memory write
receipts remain separate from Run success.

Set `MEMORY_ENDPOINT` to attach a gateway, with its credential in `MEMORY_API_KEY`.
Set `MEMORY_MODEL` and `MEMORY_BASE_URL` to enable owned Core lifecycle routes;
the shared default gateway endpoint is `http://127.0.0.1:8420`. Model credentials
are referenced by `MEMORY_MODEL_API_KEY_ENV` (default `DEEPSEEK_API_KEY`).
`MEMORY_SERVICE_ID` defaults to `agent-runtime`; `MEMORY_SERVICE_DIR` optionally overrides the owned Core directory (default `<dataDir>/memory-core`). Installation and startup require
explicit API calls; shutdown stops only the owned process. Core is pinned to
1.0.2-beta.1; existing data persists across stop/start.

Explicit resource smoke:
`RUN_HTTP_RESOURCE_SMOKE=1 CODEX_MODEL=gpt-6-astra MEMORY_MODEL=deepseek-flash MEMORY_SERVICE_DIR=/tmp/agent-runtime-owned-memory-smoke pnpm --filter @internal/server smoke:resources`.
The script loads `.env.local` without printing credentials. On 2026-09-17 this
passed HTTP resource CRUD, same-session resource updates, native MCP approvals,
accepted memory receipts, Core lifecycle and L0 persistence across restart.
Native input requests and cancellation remain unverified by this real smoke.

Migration verification (2026-09-23): controlled Fetch-boundary tests cover typed clients,
cursor replay, approval/input/cancellation, independent subscriptions, authenticated
OpenAPI, request limits and safe errors. `pnpm --filter @internal/server smoke:nitro`
checks the built Nitro process, token permissions, HTTP access, shutdown and restart
without calling a model. Historical real-model results above do not verify this
transport migration; real-model smoke must be explicitly rerun to claim that.

## A2A

The authenticated `/.well-known/agent-card.json` advertises A2A 1.0 JSON-RPC at `/a2a`, using the same Manager and bearer/Host/Origin checks as REST. The A2A routes are separate from the oRPC AG-UI event stream and are not included in `/spec.json`.

Create a managed Session through REST, then send its ID as A2A `message.contextId`. Task IDs are independent of Run IDs and remain queryable after restart. See the [official-client example](../../examples/a2a/README.md) for submission, SSE snapshots, input/approval replies, cancellation, and the explicit no-model HTTP smoke command.
