// biome-ignore-all lint/suspicious/noConsole: Interactive CLI example.
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { stdin, stdout } from 'node:process'
import { createInterface } from 'node:readline/promises'

import { SendMessageRequest, TaskState } from '@a2a-js/sdk'
import { ClientFactory, DefaultAgentCardResolver, JsonRpcTransportFactory } from '@a2a-js/sdk/client'

const [url, tokenFile, sessionId, ...words] = process.argv.slice(2)
if (!(url && tokenFile && sessionId && words.length > 0)) {
  throw new Error('Usage: pnpm --filter @internal/a2a-example start <url> <token-file> <session-id> <prompt>')
}
const token = (await readFile(tokenFile, 'utf8')).trim()
const fetchImpl: typeof fetch = (input, init) => {
  const request = new Request(input, init)
  // Discovery must not be allowed to send the local token to another origin.
  if (new URL(request.url).origin !== new URL(url).origin) {
    throw new Error('Unexpected agent origin')
  }
  request.headers.set('authorization', `Bearer ${token}`)
  return fetch(request, { redirect: 'error' })
}
const client = await new ClientFactory({
  cardResolver: new DefaultAgentCardResolver({ fetchImpl }),
  transports: [new JsonRpcTransportFactory({ fetchImpl })]
}).createFromUrl(url)
const readline = createInterface({ input: stdin, output: stdout })
const questions = new AbortController()
let taskId: string | undefined
let cancelRequested = false
const cancel = () => {
  cancelRequested = true
  if (taskId) {
    void client
      .cancelTask({ id: taskId, metadata: undefined, tenant: '' })
      .then(() => questions.abort())
      .catch((error: unknown) => console.error(error))
  }
}
process.on('SIGINT', cancel)
readline.on('SIGINT', cancel)
const answered = new Set<string>()
try {
  for await (const update of client.sendMessageStream(
    SendMessageRequest.fromJSON({
      message: { contextId: sessionId, messageId: randomUUID(), parts: [{ text: words.join(' ') }], role: 'ROLE_USER' }
    })
  )) {
    const payload = update.payload
    if (payload?.$case === 'task') {
      taskId = payload.value.id
      console.log(`Task ${taskId}; Run ${payload.value.metadata?.runId}; Ctrl+C requests cancellation.`)
      for (const artifact of payload.value.artifacts) {
        for (const part of artifact.parts) {
          if (part.content?.$case === 'text') {
            stdout.write(part.content.value)
          }
        }
      }
      if (cancelRequested) {
        cancel()
      }
    }
    if (payload?.$case === 'artifactUpdate') {
      for (const part of payload.value.artifact?.parts ?? []) {
        if (part.content?.$case === 'text') {
          stdout.write(part.content.value)
        }
      }
    }
    let status = payload?.$case === 'task' || payload?.$case === 'statusUpdate' ? payload.value.status : undefined
    if (!status) {
      continue
    }
    console.log(`\n${TaskState[status.state]}`)
    while (status?.state === TaskState.TASK_STATE_INPUT_REQUIRED && !questions.signal.aborted) {
      const request = status.message
      if (!request) {
        break
      }
      const fingerprint = JSON.stringify(request.parts)
      if (answered.has(fingerprint)) {
        break
      }
      answered.add(fingerprint)
      console.log(JSON.stringify(request.parts, null, 2))
      console.log(
        'Reply with {"inputId":"…","answers":{"question-id":["answer"]}} or {"approvalId":"…","decision":"approve"|"deny"}.'
      )
      const response: unknown = JSON.parse(
        await readline.question('Interaction JSON (no secrets): ', { signal: questions.signal })
      )
      const result = await client.sendMessage(
        SendMessageRequest.fromJSON({
          configuration: { returnImmediately: true },
          message: {
            contextId: sessionId,
            messageId: randomUUID(),
            parts: [{ data: response }],
            role: 'ROLE_USER',
            taskId
          }
        })
      )
      status = 'id' in result ? result.status : undefined
    }
  }
} catch (error) {
  if (!questions.signal.aborted) {
    throw error
  }
  console.log('Cancellation requested; query the task to confirm its final status.')
} finally {
  process.off('SIGINT', cancel)
  readline.close()
}
