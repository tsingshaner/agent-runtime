import { closeSync } from 'node:fs'
import { connect } from 'node:net'
import { createInterface } from 'node:readline'

let ignoreEnd = false
const input = createInterface({ input: process.stdin })
if (process.argv.includes('--exit-on-request')) {
  input.once('line', () => process.exit(7))
} else {
  const port = Number(process.argv[process.argv.indexOf('--control-port') + 1])
  const control = connect(port, '127.0.0.1')
  const send = (message) => control.write(`${JSON.stringify(message)}\n`)
  input.on('line', (line) => send({ event: 'received', frame: JSON.parse(line) }))
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
