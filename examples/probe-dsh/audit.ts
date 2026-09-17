// Read-only wire observation loaded before the official CLI, never writes stdout.
import { writeFileSync } from 'node:fs'

const output = process.env.DSH_PROBE_AUDIT
if (!output) {
  throw new Error('Missing probe audit path')
}
const write = process.stdout.write.bind(process.stdout)
let pending = ''
let frames = 0
let invalid = false
process.stdout.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
  pending += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
  let newline = pending.indexOf('\n')
  while (newline >= 0) {
    const line = pending.slice(0, newline).trim()
    pending = pending.slice(newline + 1)
    try {
      const frame = JSON.parse(line)
      if (frame.jsonrpc !== '2.0') {
        invalid = true
      }
      frames++
    } catch {
      invalid = true
    }
    newline = pending.indexOf('\n')
  }
  return Reflect.apply(write, process.stdout, [chunk, ...args])
}) as typeof process.stdout.write
process.on('exit', () =>
  writeFileSync(output, JSON.stringify({ clean: !invalid && pending.length === 0, frames }), { mode: 0o600 })
)
