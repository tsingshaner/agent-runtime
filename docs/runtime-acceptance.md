<!-- cspell:ignore langgraph deepagents -->

# Runtime acceptance — 2026-09-24

Evidence for #27, #28, #29, #30, #32, #33, #38, #39 and #40.
This is a verification record; [spec #10](https://github.com/tsingshaner/agent-runtime/issues/10)
remains the contract. Nothing was published or pushed.

## Versions

Node 24.11.0, pnpm 12.4.1, macOS arm64; live Codex CLI 0.155.1
(generated protocol baseline remains 0.153.4; only listed scenarios verified);
official DSH SDK/Harness/plugins 0.1.5-rc.2; deepagents 1.13.5,
LangChain 1.5.11, LangGraph 1.4.15, SQLite saver 1.0.4;
MemoryCore 1.0.2-beta.1 at fixed source commit 8f2dc83 with SDK 1.0.1-beta.1;
A2A SDK 1.2.0, TanStack AI client 0.32.0.
Hosted models: Codex `gpt-6-astra`, DSH/Deep Agents and Core `deepseek-v4-flash`.

## Results

| Boundary | Result | Evidence and limits |
| --- | --- | --- |
| Whole workspace | PASS | Build, typecheck, read-only Biome, cspell and knip. Biome has one existing warning plus informational diagnostics; knip only entry-pattern hints. |
| Credential-free full suite | PASS | 47 files passed, one skipped; 293 tests passed, three skipped; zero type errors. Hosted checks are explicitly opt-in. |
| Public archive consumer | PASS | Eight public packages installed outside the workspace; import/construct cannot spawn processes, actual PGlite migration/create/reopen succeeds. Internal shared code is private and bundled, including its files subpath. |
| DSH native lifecycle | PASS | Real SDK/Harness with local model fixture: text/tool events, history restoration, missing history, approval/denial effects, input, cancel isolation, disconnected control, process termination, cancellation timeout and unsafe-resume gate. |
| DSH hosted resources | PASS | Actual model reads selected Skill and Knowledge, calls stdio/HTTP MCP and native input; new process recalls prior secrets/answer. Controlled native tests also verify updates, disabled resources, errors and project isolation. |
| Deep Agents native lifecycle | PASS | Actual graph and disk SQLite with deterministic model: ordered text chunks, tool results, mixed approval batch, input in same Run, restart, missing/unsafe checkpoint, cooperative cancel, unconfirmed remote/custom-tool cancellation and bounded stream overflow. |
| Deep Agents native resources | PASS | Real filesystem Skill/Knowledge and real stdio/HTTP MCP through the shared bridge; updated next-run bindings, ordinary tool errors, no duplicate historical results. Model is deterministic. |
| Three hosted runtimes over built HTTP | PASS | Concurrent separate projects, durable SSE/requestId, shutdown, restart, same native identities and history recall through all three adapters. |
| Hosted cross-runtime Memory | PASS | Codex writes a unique project fact, real Core extraction makes it available to DSH and Deep Agents; a separate project cannot recall it. Core outage preserves chat success with a recall error. |
| Core lifecycle | PASS | Fixed-source install and repeat install/start/stop; accepted messages survive restart. HTTP resource smoke confirms separate memory receipts. |
| Codex hosted resources | PASS | Built HTTP CRUD, same-session resource changes, actual native MCP approvals, memory write receipts and Core restart persistence. |
| Native A2A/TanStack | PASS | Eight scenarios through built Nitro + actual Harness: input, approve, deny and cancel in each protocol; same Task/Run, terminal rejection, actual shell effects only after approval. Model HTTP/SSE is deterministic. |
| SDK terminal cancellation | PASS | Actual Ctrl+C during hosted DSH/Deep Agents input and Codex generation; persisted cancelled state, expired input and released database ownership. |
| Hosted Deep Agents input | PASS | Native ask_user answered through the CLI, same Run succeeds and returns the supplied answer; a new process resumes that Session before a later cancelled Run. |

Native protocol checks do **not** represent hosted-model protocol tests.
Hosted Codex native input was not triggered; its protocol boundary has controlled
tests. Hosted Deep Agents resource-tool and mixed-batch generation were not run;
those behaviors use the real graph with a deterministic model. Other operating
systems and dependency versions remain unverified. These limits must not be
described as universal live verification.

## Reproduction

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm --filter @internal/server build
pnpm check:type
pnpm test
pnpm check
pnpm check:cspell
pnpm check:knip
node examples/sdk/package-smoke.ts
node apps/server/nitro-smoke.ts
RUN_NATIVE_PROTOCOL_SMOKE=1 node examples/a2a/native-smoke.ts

RUN_RUNTIME_SMOKE=1 CODEX_MODEL=gpt-6-astra \
  DSH_MODEL=deepseek-v4-flash DEEPAGENTS_MODEL=deepseek-v4-flash \
  DEEPAGENTS_API_KEY_ENV=DEEPSEEK_API_KEY DEEPAGENTS_BASE_URL=https://api.deepseek.com \
  node --env-file=.env.local apps/server/multi-runtime-smoke.ts

DSH_LIVE=1 DSH_MODEL=deepseek-v4-flash \
  node --env-file=.env.local node_modules/vitest/vitest.mjs run packages/runtime-dsh/src/live.test.ts
```

The last two commands call hosted models; ordinary tests never do. Supply credentials
through the environment or ignored `.env.local`, never command literals. Live Memory
checks require an explicitly installed Core directory; see [SDK checks](../examples/sdk/README.md),
[MemoryCore setup](../examples/memory-service/README.md) and [HTTP resource smoke](../apps/server/README.md).

Terminal cancellation is reproducible with the SDK CLI and an isolated `RUNTIME_DATA_DIR`:
ask DSH/Deep Agents for native user input or ask Codex for a long response, then press
Ctrl+C. Reopen through RuntimeManager and inspect the emitted Run ID: cancelled state,
expired interactions and one terminal event. Failure to confirm native cancellation
is reported distinctly; unfinished native state is preserved and refused on resume.
