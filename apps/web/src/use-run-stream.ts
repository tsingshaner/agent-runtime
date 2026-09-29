import { getEventMeta, ORPCError } from '@orpc/client'
import { StreamProcessor } from '@tanstack/ai-client'
import { useEffect, useState } from 'react'

import { api } from './api'

type Chunk = Parameters<StreamProcessor['processChunk']>[0]
const eventSequence = (id: string | undefined) => {
  const sequence = Number(id)
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new Error('Missing event cursor')
  }
  return sequence
}

export const useRunStream = (
  runId: string,
  cleared: boolean
): {
  error: string
  messages: ReturnType<StreamProcessor['getMessages']>
  reconnect: () => void
} => {
  const [messages, setMessages] = useState<ReturnType<StreamProcessor['getMessages']>>([])
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (cleared) {
      setMessages([])
      setError('')
      return
    }
    const stop = new AbortController()
    const processor = new StreamProcessor()
    let sequence = 0
    let terminal = false
    setMessages([])
    setError(attempt > 0 ? '正在重新连接事件…' : '')
    const consume = async () => {
      const stream = await api.runs.events(
        { params: { id: runId }, query: { afterSequence: sequence } },
        { signal: stop.signal }
      )
      for await (const event of stream) {
        const next = eventSequence(getEventMeta(event)?.id)
        if (next <= sequence) {
          continue
        }
        processor.processChunk(event as unknown as Chunk)
        sequence = next
        terminal = event.type === 'RUN_FINISHED' || event.type === 'RUN_ERROR'
        setMessages([...processor.getMessages()])
        setError('')
      }
      if (!terminal) {
        throw new Error('Subscription ended before terminal event')
      }
    }
    const watch = async (retry = 0): Promise<void> => {
      try {
        await consume()
      } catch (failure) {
        if (stop.signal.aborted) {
          return
        }
        setError('事件连接中断，运行状态以服务端为准。')
        if (terminal || failure instanceof ORPCError || retry >= 5) {
          return
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(done, Math.min(500 * 2 ** retry, 8000))
          function done() {
            clearTimeout(timer)
            stop.signal.removeEventListener('abort', done)
            resolve()
          }
          stop.signal.addEventListener('abort', done, { once: true })
        })
        await watch(retry + 1)
      }
    }
    void watch()
    return () => stop.abort()
  }, [runId, cleared, attempt])
  return { error, messages, reconnect: () => setAttempt((value) => value + 1) }
}
