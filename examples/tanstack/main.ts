// biome-ignore-all lint/suspicious/noConsole: Interactive CLI example.
import { readFile } from 'node:fs/promises'
import { stdin, stdout } from 'node:process'
import { createInterface } from 'node:readline/promises'

import { RuntimeClient } from './client.ts'

const [url, tokenFile, sessionId, ...words] = process.argv.slice(2)
if (!(url && tokenFile && sessionId) || words.length === 0) {
  throw new Error('Usage: pnpm --filter @internal/tanstack-example start <url> <token-file> <session-id> <prompt>')
}
const client = new RuntimeClient(url, (await readFile(tokenFile, 'utf8')).trim())
const readline = createInterface({ input: stdin, output: stdout })
const { runId } = await client.submit(sessionId, words.join(' '))
console.log(`Run ${runId}; Ctrl+C requests cancellation.`)
const questions = new AbortController()
const cancel = () => {
  void client
    .cancel(runId)
    .then(() => questions.abort())
    .catch((error: unknown) => console.error(error))
}
process.on('SIGINT', cancel)
readline.on('SIGINT', cancel)
try {
  const result = await client.watch(runId, {
    approval: async (request, signal) => {
      console.log('\nApproval:', request.kind, request.detail)
      return (await readline.question('Type approve to allow; anything else denies: ', {
        signal: AbortSignal.any([questions.signal, signal])
      })) === 'approve'
        ? 'approve'
        : 'deny'
    },
    input: async (request, signal) => {
      const answers: Record<string, string[]> = {}
      for (const question of request.questions) {
        if (question.isSecret) {
          throw new Error('Secret input requires a client with masked entry; request remains pending')
        }
        console.log(question.options ?? '')
        answers[question.id] = [
          await readline.question(`${question.question} `, { signal: AbortSignal.any([questions.signal, signal]) })
        ]
      }
      return answers
    },
    onEvent: (event) => {
      if (event.type === 'TEXT_MESSAGE_CONTENT') {
        stdout.write(event.delta)
      }
      if (event.type === 'TOOL_CALL_START') {
        console.log(`\nTool: ${event.toolCallName}`)
      }
      if (event.type === 'TOOL_CALL_RESULT') {
        console.log(`\nTool result: ${event.content}`)
      }
    }
  })
  console.log(`\n${result.terminal.type}`)
} catch (error) {
  if (!questions.signal.aborted) {
    throw error
  }
  console.log('Cancellation requested')
} finally {
  process.off('SIGINT', cancel)
  readline.close()
}
