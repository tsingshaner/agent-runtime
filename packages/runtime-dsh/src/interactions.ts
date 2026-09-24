import { randomUUID } from 'node:crypto'

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-user-questions'
import type { AdapterNotice, InputAnswers, JsonObject } from '@qingshaner/runtime'

export const interactions = (ctx: Context, sessionId: string, send: (notice: AdapterNotice) => void) => {
  const pending = new Map<string, (value: unknown) => void>()
  const wait = async (id: string, signal: AbortSignal | undefined, notice: AdapterNotice) => {
    signal?.throwIfAborted()
    let abort: () => void = () => {}
    try {
      return await new Promise<unknown>((resolve, reject) => {
        abort = () => reject(new Error('Interaction withdrawn'))
        pending.set(id, resolve)
        signal?.addEventListener('abort', abort, { once: true })
        send(notice)
      })
    } finally {
      signal?.removeEventListener('abort', abort)
      pending.delete(id)
    }
  }
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec.agent?.id !== sessionId) {
      return { kind: 'deny', reason: 'Unknown session' }
    }
    if (exec.name === 'ask_user_question') {
      return next()
    }
    const id = randomUUID()
    let attempted = false
    try {
      const answer = await wait(id, exec.signal, {
        kind: 'approval',
        request: {
          allowedDecisions: ['approve', 'deny'],
          detail: { arguments: exec.arguments as JsonObject, name: exec.name },
          kind: 'tool',
          nativeRequestId: id
        }
      })
      attempted = true
      return answer === 'approve' ? await next() : { kind: 'deny', reason: 'User denied operation' }
    } catch {
      return { kind: 'deny', reason: 'Approval channel unavailable' }
    } finally {
      send({ kind: 'approval-resolved', nativeRequestId: id, responseAttempted: attempted })
    }
  })
  ctx.on('user-questions/request', async (request) => {
    if (request.agent?.id !== sessionId || request.questions.some((q) => q.intent)) {
      throw new Error('Unsupported input interaction')
    }
    const id = randomUUID()
    let attempted = false
    try {
      const answer = (await wait(id, request.signal, {
        kind: 'input',
        request: {
          nativeRequestId: id,
          questions: request.questions.map((q) => ({
            header: q.header ?? '',
            id: q.id,
            isOther: true,
            options: q.options?.map((o) => ({ description: o.description ?? '', label: o.label })),
            question: q.question
          }))
        }
      })) as InputAnswers
      const answers = request.questions.map((q) => {
        const supplied = answer[q.id]
        if (
          !Array.isArray(supplied) ||
          supplied.some((value) => typeof value !== 'string') ||
          (!q.multiSelect && supplied.length > 1)
        ) {
          throw new Error('Invalid input answer')
        }
        const selected = supplied.filter((value) => q.options?.some((option) => option.label === value))
        const custom = supplied.filter((value) => !selected.includes(value)).join('\n')
        return { id: q.id, selected, ...(custom ? { custom } : {}) }
      })
      attempted = true
      return { answers }
    } finally {
      send({ kind: 'input-resolved', nativeRequestId: id, responseAttempted: attempted })
    }
  })
  return (body: { id?: unknown; decision?: unknown; answers?: unknown }) => {
    if (typeof body.id !== 'string') {
      throw new Error('Invalid interaction ID')
    }
    const resolve = pending.get(body.id)
    if (!resolve) {
      throw new Error('Interaction missing')
    }
    if (body.decision !== undefined && body.decision !== 'approve' && body.decision !== 'deny') {
      throw new Error('Invalid decision')
    }
    pending.delete(body.id)
    resolve(body.decision ?? body.answers)
  }
}
