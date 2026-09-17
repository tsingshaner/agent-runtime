// biome-ignore-all lint/suspicious/noConsole: Standalone probe report.
import { probeGateway } from './gateway.ts'

if (!process.env.MEMORY_CORE_DIR) {
  console.log('SKIPPED: set MEMORY_CORE_DIR to the fixed, installed MemoryCore source directory (see README).')
} else {
  console.log(JSON.stringify(await probeGateway(process.env.MEMORY_CORE_DIR), null, 2))
}
