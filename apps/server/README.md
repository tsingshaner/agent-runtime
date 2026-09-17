# Local runtime HTTP service

Run `pnpm --filter @internal/server start`. `RUNTIME_DATA_DIR` defaults to
`.agent-runtime`; `PORT` defaults to 4310. The listener binds 127.0.0.1 only.
Read the generated bearer token from `http-token` in that data directory (mode
0600); send it as `Authorization: Bearer <token>`, never in a URL. Programmatic
`startServer` returns the token without logging it and accepts an explicit
`origins` allowlist for browser clients. SIGINT/SIGTERM close the owned Manager.

All request bodies use JSON. Creation of a session requires explicit `model`,
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
Run terminal event. Errors omit raw native diagnostics and request contents.

Normal tests use real HTTP and PGlite with a controlled adapter, no model calls.
Explicit real smoke: `RUN_CODEX_SMOKE=1 CODEX_MODEL=<model> pnpm --filter @internal/server smoke`.
On 2026-09-17, Codex 0.153.4 / gpt-6-astra passed real submission, text SSE,
unique success and cursor replay. Native approval/input/cancellation were not
triggered (UNVERIFIED); controlled HTTP tests cover those routes.


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
`MEMORY_SERVICE_ID` defaults to `agent-runtime`. Installation and startup require
explicit API calls; shutdown stops only the owned process. Core is pinned to
1.0.2-beta.1; existing data persists across stop/start.

Explicit resource smoke:
`RUN_HTTP_RESOURCE_SMOKE=1 CODEX_MODEL=gpt-6-astra MEMORY_MODEL=deepseek-flash MEMORY_SERVICE_DIR=/tmp/agent-runtime-owned-memory-smoke pnpm --filter @internal/server smoke:resources`.
The script loads `.env.local` without printing credentials. On 2026-09-17 this
passed HTTP resource CRUD, same-session resource updates, native MCP approvals,
accepted memory receipts, Core lifecycle and L0 persistence across restart.
Native input requests and cancellation remain unverified by this real smoke.
