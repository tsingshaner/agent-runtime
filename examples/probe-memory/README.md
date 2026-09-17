<!-- cspell:ignore TencentDB tencentdb TDAI codeload shasum esbuild Dedup mktemp -->

# MemoryCore pairing probe (#14)

This is a disposable capability probe, not the production lifecycle manager. It uses the official SDK against a real Node Gateway, temporary application data, and only child processes it starts. No Docker, user configuration changes, or upstream source patches.

## Fixed pair and installation

- Core source: [TencentDB Agent Memory commit 8f2dc83](https://github.com/TencentCloud/TencentDB-Agent-Memory/tree/8f2dc830317934e54548472bf62c5999f9bb1202), package version `1.0.2-beta.1`.
- SDK: `@tencentdb-agent-memory/memory-sdk-ts-v2@1.0.1-beta.1` (workspace lock).
- Verified on Node `v24.11.0`, macOS arm64. Other platforms are unverified.

Use a **new empty directory** for installation. Installation is separate from every probe start:

```sh
probe_install=$(mktemp -d)
curl --fail --location https://codeload.github.com/TencentCloud/TencentDB-Agent-Memory/tar.gz/8f2dc830317934e54548472bf62c5999f9bb1202 -o "$probe_install/core.tar.gz"
shasum -a 256 "$probe_install/core.tar.gz"
# Must be bbe69042f1d58ffdace3169427d9714b7d6b87071a220279ca181a763e00e186
# Stop if this hash differs.
tar -xzf "$probe_install/core.tar.gz" -C "$probe_install" --strip-components=1
cd "$probe_install/MemoryCore"
npm install --ignore-scripts --no-audit --no-fund --registry=https://registry.npmjs.org
export MEMORY_CORE_DIR="$probe_install/MemoryCore"
```

Keep the generated installation `package-lock.json`; subsequent reconstruction of that dependency tree uses `npm ci --ignore-scripts`. Upstream source has no lockfile, so the commit fixes Core source but not transitive npm resolution on a fresh installation. Optional platform packages must remain enabled (`tsx` requires the platform esbuild binary). The probe runs the source Gateway with the installed `tsx`; no plugin bundle is needed. It checks package version and Gateway source SHA-256 before spawning. It never downloads or upgrades during startup.

From this repository after the workspace dependencies are installed:

```sh
node examples/probe-memory/main.ts
node_modules/.bin/vitest run examples/probe-memory/probe.test.ts
```

Without `MEMORY_CORE_DIR`, the CLI reports `SKIPPED` and the real Gateway test is skipped. The lost-response HTTP test always runs without credentials.

## Identity and observable checks

`serviceId=probe-memory`, `teamId=projectId`, `agentId=agent-runtime`, `userId=local-user`. The runtime kind only labels the source session; it never changes the logical memory identity. This models three runtime sources through the SDK; it does not execute all three adapters.

The probe writes six L0 messages across Codex, DSH and Deep Agents session labels. Project A can query/search them across sessions; project B cannot. In structural mode it separately writes distinct L3 profiles through the SDK. In live mode it preserves the generated A profile and seeds only B as a negative control. It stops its Gateway, starts a fresh process against the same temporary data, and verifies the same original message IDs and isolated profiles. Profile seeding tests aggregate **storage**, not extraction or aggregation generation. Temporary data is deleted in `finally` after owned-process shutdown.

A repeated write with the same caller-supplied message IDs produces two more records. The fixed Core generates fresh server IDs; SDK `id` support is **not** a deduplication guarantee. The automated fault test accepts a request then drops its socket: the wrapper reports `unknown`, retains the run identity, and sends no second request. It deliberately does not implement a retry queue or classify every production error.

## Explicit live generation path

```sh
export MEMORY_PROBE_LIVE=1
export TDAI_LLM_BASE_URL='https://your-openai-compatible-provider/v1'
export TDAI_LLM_MODEL='your-explicit-model'
# Set TDAI_LLM_API_KEY securely in your environment.
node examples/probe-memory/main.ts
```

Live mode requires all three model settings. It enables extraction and short pipeline thresholds, polls until a 60-second deadline for nonempty L1 search results, L2 scenarios and a generated L3 profile containing the project marker, then asserts the other project cannot read any of them. In-flight SDK calls have a 5-second timeout; the deadline does not abort an already-started call. Cobalt is written only by the Codex-labelled session; all three runtime-labelled sessions must recall it. `recallProject` clears the session filter and combines official v3 `searchAtomic`, `readCore` and `listScenarios`, with at most five atomic hits and five scenario summaries. This is **v3 composite recall**, not a native SDK `recall()` method. The legacy `/recall` route does not receive the project isolation tuple and is deliberately unused. Failure to trigger every layer reports `UNVERIFIED`, never `PASS`. Structural storage assertions remain independent of model quality.

## Observed result (2026-09-17)

- PASS: fixed-source Gateway health, SDK add/query/L0 keyword search, cross-session sharing, project L0 isolation, seeded L3 isolation, process restart preserving message IDs and profiles, owned-process cleanup.
- NOT_IDEMPOTENT: same SDK message IDs add new records (6 → 8).
- PASS: accepted-but-lost HTTP response returns `unknown` without retransmission.
- PASS (subsequent explicit live run): actual L1/L2/L3 generation with `deepseek-flash`, v3 composite recall of the Codex-only cobalt fact by all three runtime-labelled sessions, and absence of that generated memory in project B. Project A retained its generated profile across restart; project B retained its distinct amber profile. Credentials came from the user-provided local environment file and were never printed. No deterministic model fixture was used.
- UNVERIFIED: execution through the three actual runtime adapters (this probe tests their source identity mapping), model quality beyond the marker assertions, and platforms other than this macOS/Node pair.

The fixed source/SDK pair supports this Node-only extraction scenario. This remains a capability probe; production installation, retries, recovery and lifecycle ownership belong to the resource implementation. The model/endpoint were checked against the [official DeepSeek API guide](https://api-docs.deepseek.com/): `deepseek-flash` at `https://api.deepseek.com`. Reference the [official standalone guide](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/8f2dc830317934e54548472bf62c5999f9bb1202/MemoryCore/README.md) and [actual write handler](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/8f2dc830317934e54548472bf62c5999f9bb1202/MemoryCore/src/gateway/v2-router.ts).
