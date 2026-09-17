# Real MemoryCore lifecycle smoke (#24)

Run from the repository root after workspace dependencies are installed:

```sh
pnpm --filter @internal/memory-service-example smoke
```

The default prints **SKIPPED**. To install the fixed Core and verify actual
Gateway lifecycle and persistent conversations, explicitly enable it:

```sh
RUN_MEMORY_SERVICE_SMOKE=1 \
MEMORY_SERVICE_DIR=/absolute/application-data/memory-smoke \
MEMORY_MODEL=deepseek-flash \
MEMORY_BASE_URL=https://api.deepseek.com \
MEMORY_API_KEY_ENV=DEEPSEEK_API_KEY \
MEMORY_ENDPOINT=http://127.0.0.1:18420 \
pnpm --filter @internal/memory-service-example smoke
```

Supply the referenced model credential through the environment or the repository's
ignored `.env.local`. The script loads that file if present; keys are never
printed. The Gateway token is generated for this smoke process. Use a dedicated
data directory: supplying `MEMORY_SERVICE_DIR` preserves installation and data;
omitting it uses and removes a temporary directory. All owned processes are
closed in either case. Installation requires npm, tar and network access.

Checks use the **built public package** and official Memory SDK `1.0.1-beta.1`:
verified installation, a repeated install that cannot download another archive,
healthy start, repeated start, two exact conversation IDs/content, repeated stop,
restart and identical persisted messages. Each run uses a fresh project/session
identity. This smoke does not claim to verify extraction quality or all runtime
adapters; those are separate integration scenarios.

Recorded 2026-09-17: Node `24.11.0`, macOS arm64, fixed Core `1.0.2-beta.1`:
**PASS** for actual fresh installation and subsequent lifecycle/persistence smoke,
including 2 retained messages, repeat install/start/stop and owned-process cleanup.
The first smoke exposed a missing SDK session identity before writing; it was
corrected and the complete persistence path then passed.
