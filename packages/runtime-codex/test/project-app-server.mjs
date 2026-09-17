// biome-ignore-all lint/style/useNamingConvention: Native protocol uses snake_case configuration keys.
import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

const audit = process.argv[2]
const home = process.env.CODEX_HOME
const state = join(home, 'test-threads.json')
mkdirSync(home, { recursive: true })
const threads = new Set(existsSync(state) ? JSON.parse(readFileSync(state, 'utf8')) : [])
const send = (frame) => process.stdout.write(`${JSON.stringify(frame)}\n`)
const active = new Map()
const disabled = new Set()
createInterface({ input: process.stdin })
  .on('line', (line) => {
    const frame = JSON.parse(line)
    appendFileSync(audit, `${JSON.stringify({ home, pid: process.pid, userHome: process.env.HOME, ...frame })}\n`)
    const reply = (result) => send({ id: frame.id, result })
    switch (frame.method) {
      case 'initialize':
        reply({ codexHome: home, platformFamily: 'unix', platformOs: 'macos', userAgent: 'fixture' })
        break
      case 'initialized':
        break
      case 'config/read':
        reply({ config: { mcp_servers: { unbound: { command: 'never-run' } } } })
        break
      case 'skills/extraRoots/set':
        reply({})
        break
      case 'skills/list':
        reply({
          data: [
            { skills: [{ enabled: !disabled.has('/unbound/SKILL.md'), name: 'unbound', path: '/unbound/SKILL.md' }] }
          ]
        })
        break
      case 'skills/config/write':
        disabled.add(frame.params.path)
        reply({})
        break
      case 'thread/start': {
        const id = randomUUID()
        mkdirSync(join(home, 'sessions'), { recursive: true })
        writeFileSync(join(home, 'sessions', `rollout-fixture-${id}.jsonl`), JSON.stringify({ id }))
        threads.add(id)
        writeFileSync(state, JSON.stringify([...threads]))
        reply({ cwd: frame.params.cwd, model: frame.params.model, thread: { id } })
        break
      }
      case 'thread/resume':
        if (
          !(
            threads.has(frame.params.threadId) ||
            existsSync(join(home, 'sessions', `rollout-fixture-${frame.params.threadId}.jsonl`))
          )
        ) {
          send({ error: { code: -32602, message: 'Missing native thread' }, id: frame.id })
        } else {
          reply({ cwd: frame.params.cwd, model: frame.params.model, thread: { id: frame.params.threadId } })
        }
        break
      case 'turn/start': {
        if (frame.params.input[0].text === 'crash') {
          process.exit(7)
        }
        const id = randomUUID()
        active.set(frame.params.threadId, id)
        reply({ turn: { error: null, id, status: 'inProgress' } })
        break
      }
      case 'turn/interrupt':
        reply({})
        send({
          method: 'turn/completed',
          params: {
            threadId: frame.params.threadId,
            turn: { error: null, id: active.get(frame.params.threadId), status: 'interrupted' }
          }
        })
        break
      default:
        send({ error: { code: -32601, message: 'Unsupported' }, id: frame.id })
    }
  })
  .on('close', () => process.exit(0))
