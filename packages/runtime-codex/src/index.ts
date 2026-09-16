import { spawn } from 'node:child_process'
import readline from 'node:readline'

const proc = spawn('codex', ['app-server'], {
  stdio: ['pipe', 'pipe', 'inherit']
})
const rl = readline.createInterface({ input: proc.stdout })

const send = (message: unknown) => {
  proc.stdin.write(`${JSON.stringify(message)}\n`)
}

let threadId: string | null = null

rl.on('line', (line) => {
  const msg = JSON.parse(line) as any
  console.log('server:', msg)

  if (msg.id === 1 && msg.result?.thread?.id && !threadId) {
    threadId = msg.result.thread.id
    send({
      id: 2,
      method: 'turn/start',
      params: {
        input: [{ text: 'Summarize this repo.', type: 'text' }],
        threadId
      }
    })
  }
})

send({
  id: 0,
  method: 'initialize',
  params: {
    clientInfo: {
      name: 'my_product',
      title: 'My Product',
      version: '0.1.0'
    }
  }
})
send({ method: 'initialized', params: {} })
send({ id: 1, method: 'thread/start', params: { model: 'gpt-5.6-terra' } })
