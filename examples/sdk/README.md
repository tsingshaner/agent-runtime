# SDK example

Run from the repository root with Node.js 24 and installed workspace dependencies:

```sh
RUNTIME=codex RUNTIME_MODEL=gpt-6-astra pnpm example:sdk
RUNTIME=dsh RUNTIME_MODEL=deepseek-v4-flash pnpm example:sdk
RUNTIME=deepagents RUNTIME_MODEL=deepseek-v4-flash \
  DEEPAGENTS_BASE_URL=https://api.deepseek.com DEEPAGENTS_API_KEY_ENV=DEEPSEEK_API_KEY pnpm example:sdk
```

Supply provider credentials in the environment. DSH uses `DEEPSEEK_API_KEY`;
Deep Agents defaults to `OPENAI_API_KEY`. Codex uses its configured CLI identity.
`DSH_BASE_URL` and `DEEPAGENTS_BASE_URL` select compatible providers.

`RUNTIME_DATA_DIR` defaults to `.agent-runtime`; only one SDK or server host may
own it. `PROJECT_ID` defaults to `demo`. Switching runtimes creates a new Session
in the same Project. `SESSION_ID` explicitly resumes a matching project/runtime/model;
it never migrates history between runtimes. `REQUEST_ID` deduplicates the exact
`PROMPT` within that Session. Without `PROMPT`, the example describes the directory.

The CLI prints durable events, asks for approvals and input when attached to a
terminal, and cancels on Ctrl+C. Without a terminal, approvals are denied and
input cancels the run; hidden input also cancels the run. The example waits briefly
for the separate memory receipt and prints its actual status. `unknown` is never
automatically retried. All owned resources close in `finally`.

Set `MEMORY_ENDPOINT`, `MEMORY_API_KEY` and optionally `MEMORY_SERVICE_ID` to use
an already-running MemoryCore. Same-project runtimes share this memory; different
Projects remain isolated. Core installation/start are separate operations, shown
in [the MemoryCore example](../memory-service/README.md).

Project resources use the same persisted resource directories as the server.
`KNOWLEDGE_DIR` binds a Markdown directory; `SKILL_ID` and `MCP_ID` enable resources
already imported/configured with the public Skills/MCP APIs. Other existing
bindings are preserved. [resources-smoke.ts](resources-smoke.ts) demonstrates
import, binding, both MCP transports and safe updates entirely through SDK APIs.

## Reproducible checks

```sh
pnpm --filter @internal/sdk-example smoke:package
pnpm exec vitest run examples/sdk/smoke.test.ts

RUN_CROSS_RUNTIME_SMOKE=1 CODEX_MODEL=gpt-6-astra \
  DSH_MODEL=deepseek-v4-flash DEEPAGENTS_MODEL=deepseek-v4-flash \
  MEMORY_MODEL=deepseek-v4-flash MEMORY_SERVICE_DIR=/absolute/installed/core \
  pnpm --filter @internal/sdk-example smoke:cross-runtime
```

The packaging check installs archives into a fresh directory outside the repository,
imports every public package, verifies inert adapter construction and runs actual
PGlite migrations and persistent reopen. It requires registry access but no model
credentials. Internal shared code is bundled, never installed as a public dependency.

The live cross-runtime check uses actual hosted models and an already-installed
Core (default endpoint `http://127.0.0.1:18427`). It writes a unique fact through
Codex, waits for extraction, recalls through DSH and Deep Agents, checks a separate
Project, checks request deduplication and explicit resume, then stops its own Core
to verify chat degradation. Temporary SDK data is removed; the specified Core
installation and data remain. Without opt-in it prints `SKIPPED`. It fails if
extraction or any assertion does not occur; it does not mark missing evidence passed.

Recorded 2026-09-24 on Node 24.11.0/macOS arm64: hosted cross-runtime check **PASS**
with Codex `gpt-6-astra`, DSH/Deep Agents `deepseek-v4-flash` and Core `1.0.2-beta.1`.
This scenario does not trigger tools, approvals or native input; adapter and
protocol acceptance results are recorded separately.
