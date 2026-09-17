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
