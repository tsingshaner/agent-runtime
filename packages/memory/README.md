<!-- cspell:ignore memorycore -->

# @qingshaner/memory

Owned MemoryCore lifecycle for Node.js 24. This package currently provides the
service manager for #24; project memory CRUD/recall integration belongs to #25.
No import or constructor starts a process, installs software, or changes user
configuration.

```ts
import { MemoryCoreService } from '@qingshaner/memory'

const service = new MemoryCoreService({
  directory: '/absolute/application-data/memory',
  endpoint: 'http://127.0.0.1:8420',
  gatewayApiKeyEnv: 'MEMORY_GATEWAY_TOKEN',
  serviceId: 'agent-runtime',
  model: {
    name: 'your-explicit-model',
    baseUrl: 'https://your-provider/v1',
    apiKeyEnv: 'MEMORY_MODEL_API_KEY'
  }
})

await service.install() // Explicit network/install operation, safe to repeat.
await service.start()   // Requires an existing installation and both credentials.
console.log(await service.status()) // Never returns credential values.
await service.stop()    // Data remains available for the next start.
await service.dispose() // Idempotent; permanently rejects new start/install work.
```

`install({ archivePath })` optionally accepts a locally downloaded copy of the
**same pinned archive**; its SHA-256 is still verified. There is no arbitrary
release, executable, or startup auto-upgrade option.

The fixed source is TencentDB Agent Memory commit
`8f2dc830317934e54548472bf62c5999f9bb1202`, Core `1.0.2-beta.1`, verified by the
[#14 probe](../../examples/probe-memory/README.md). Installation downloads the
archive, verifies its checksum before extraction, runs npm with lifecycle scripts
disabled, and atomically publishes the completed version. Installation needs
`tar`, `npm`, and network access; macOS arm64/Node 24.11.0 is verified. Other
platforms are unverified. The upstream source has no dependency lock: the first
installation resolves its dependency ranges and preserves the resulting
`package-lock.json`. Repeated installation uses the completed local version;
startup never resolves dependencies or runs npm.

Application layout:

```text
memory/
  versions/<commit>/     # Fixed source, installed dependencies and completion marker
  data/                  # Persistent service state, separate from program version
  .memorycore.lock/      # Exclusive ownership and private active Gateway config
```

The application directory must be dedicated to this manager. Different instances
cannot concurrently install/start in that directory. An existing lock is never
automatically reclaimed, including after a host crash. Verify manually that no
old Gateway is using the data before removing a stale lock. No process is adopted
from disk, and `stop()` on another instance cannot stop the original owner.

`status()` reports this instance's process ownership, last known readiness,
installation version and safe failure code/message. `running` is reached only
after the **owned child's** listening notification and successful `/health`;
an already healthy server on the same port does not satisfy startup. Unexpected
exit changes the status to `failed`. Raw process output and credentials are not
returned. Both credential references are resolved at each start; the private
config (0600 within a 0700 lock directory) is removed after the child closes.

Lifecycle operations serialize per instance. Startup defaults to a 30-second
health deadline and shutdown sends TERM, then KILL after 5 seconds, awaiting
confirmed child closure before releasing ownership. These two deadlines are
configurable via `startupTimeoutMs` and `shutdownTimeoutMs` (1–120000 ms).
Download is bounded at 120 seconds/256 MiB and each install command at 180 seconds.
Stop/dispose waits for any in-progress installation or startup to settle. Failed
installation only removes its staging directory; persistent data is preserved.

The service endpoint accepts only HTTP loopback addresses (`127.0.0.1` or `::1`).
Model endpoint, model name and service identity are explicit. Token generation,
project identities and client configuration remain the caller's responsibility.

See [real lifecycle smoke](../../examples/memory-service/README.md) for the
opt-in install/start/restart verification. Ordinary tests use a real subprocess
fixture without a model, downloads, or Docker.
