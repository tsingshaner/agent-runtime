// biome-ignore-all lint/style/useNamingConvention: Native protocol uses snake_case configuration keys.
import { closeSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

let ignoreEnd = false
const input = createInterface({ input: process.stdin })
if (process.argv.includes('--exit-on-request')) {
  input.once('line', () => process.exit(7))
} else {
  const port = Number(process.argv[process.argv.indexOf('--control-port') + 1])
  const control = connect(port, '127.0.0.1')
  const send = (message) => control.write(`${JSON.stringify(message)}\n`)
  const stateIndex = process.argv.indexOf('--state-dir')
  const statePath = stateIndex < 0 ? undefined : join(process.argv[stateIndex + 1], 'threads.json')
  const threads = new Set(statePath && existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : [])
  const starts = new Set()
  input.on('line', (line) => {
    const frame = JSON.parse(line)
    if (frame.method === 'config/read') {
      process.stdout.write(`${JSON.stringify({ id: frame.id, result: { config: { mcp_servers: {} } } })}\n`)
      return
    }
    if (
      frame.method === 'skills/extraRoots/set' ||
      frame.method === 'skills/config/write' ||
      frame.method === 'skills/list'
    ) {
      process.stdout.write(
        `${JSON.stringify({ id: frame.id, result: frame.method === 'skills/list' ? { data: [{ skills: [] }] } : {} })}\n`
      )
      return
    }
    if (statePath && frame.method === 'thread/start') {
      starts.add(frame.id)
    }
    if (statePath && frame.method === 'thread/resume' && !threads.has(frame.params.threadId)) {
      process.stdout.write(
        `${JSON.stringify({ error: { code: -32602, message: 'Unknown saved thread' }, id: frame.id })}\n`
      )
    }
    send({ event: 'received', frame })
  })
  input.on('close', () => {
    send({ event: 'stdin-end' })
    if (!ignoreEnd) {
      process.exit(0)
    }
  })
  const commands = createInterface({ input: control })
  commands.on('line', (line) => {
    const command = JSON.parse(line)
    const ack = () => send({ event: 'ack' })
    switch (command.action) {
      case 'send':
        if (statePath && starts.delete(command.frame.id) && command.frame.result?.thread?.id) {
          threads.add(command.frame.result.thread.id)
          writeFileSync(statePath, JSON.stringify([...threads]))
        }
        process.stdout.write(`${JSON.stringify(command.frame)}\n`, ack)
        break
      case 'raw':
        process.stdout.write(Buffer.from(command.bytes), ack)
        break
      case 'repeat':
        process.stdout.write(command.text.repeat(command.count), ack)
        break
      case 'stderr':
        process.stderr.write(command.text, ack)
        break
      case 'pause':
        process.stdin.pause()
        ack()
        break
      case 'resume':
        process.stdin.resume()
        ack()
        break
      case 'close-input':
        ignoreEnd = true
        input.close()
        process.stdin.destroy()
        closeSync(0)
        ack()
        break
      case 'stubborn':
        ignoreEnd = true
        process.on('SIGTERM', () => send({ event: 'sigterm' }))
        ack()
        break
      case 'exit':
        process.exit(command.code ?? 7)
        break
      default:
        throw new Error('Unknown control command')
    }
  })
  control.on('connect', () => send({ event: 'ready', pid: process.pid }))
  control.on('error', () => process.exit(0))
}
