import { RuntimeError } from './errors'

import type { SessionStore } from './store'
import type { EventEnvelope } from './types'

type EventSource = Pick<SessionStore, 'getRun' | 'readEventPage' | 'onRunChange' | 'assertAvailable'>

export function subscribeToRun(
  store: EventSource,
  runId: string,
  options: { afterSequence?: number; signal?: AbortSignal } = {}
): AsyncIterable<EventEnvelope> {
  return {
    [Symbol.asyncIterator]() {
      let stopped = false
      let revision = 0
      let wake: (() => void) | undefined
      const stop = () => {
        stopped = true
        wake?.()
      }
      const { signal } = options
      // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Keep the cursor, notification, and cleanup ordering together in this iterator.
      const generator = (async function* () {
        if (stopped || signal?.aborted) {
          return
        }
        const unsubscribe = store.onRunChange(runId, () => {
          revision++
          wake?.()
        })
        signal?.addEventListener('abort', stop, { once: true })
        let sequence = options.afterSequence === undefined ? 0 : options.afterSequence
        try {
          store.assertAvailable()
          const initial = await store.getRun(runId)
          if (initial.eventsCleared) {
            throw new RuntimeError('EVENTS_CLEARED', `Events cleared: ${runId}`)
          }
          if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence > initial.lastSequence) {
            throw new RuntimeError('INVALID_INPUT', 'Invalid subscription cursor')
          }
          while (!(stopped || signal?.aborted)) {
            store.assertAvailable()
            const observed = revision
            const page = await store.readEventPage(runId, sequence)
            for (const event of page) {
              if (stopped || signal?.aborted) {
                return
              }
              store.assertAvailable()
              if ((await store.getRun(runId)).eventsCleared) {
                throw new RuntimeError('EVENTS_CLEARED', `Events cleared: ${runId}`)
              }
              if (stopped || signal?.aborted) {
                return
              }
              store.assertAvailable()
              yield event
              sequence = event.sequence
            }
            if (page.length > 0) {
              continue
            }
            const run = await store.getRun(runId)
            if (run.eventsCleared) {
              throw new RuntimeError('EVENTS_CLEARED', `Events cleared: ${runId}`)
            }
            // A terminal transition may commit after the empty page was read.
            if (run.lastSequence > sequence) {
              continue
            }
            if (['succeeded', 'failed', 'cancelled', 'interrupted'].includes(run.status)) {
              return
            }
            if (!stopped && revision === observed) {
              await new Promise<void>((resolve) => {
                wake = resolve
                if (stopped || revision !== observed || signal?.aborted) {
                  resolve()
                }
              })
              wake = undefined
            }
          }
        } catch (error) {
          store.assertAvailable()
          throw error
        } finally {
          unsubscribe()
          signal?.removeEventListener('abort', stop)
          wake = undefined
        }
      })()
      return {
        next: () => generator.next(),
        return: () => {
          stop()
          return generator.return(undefined)
        },
        throw: (error?: unknown) => {
          stop()
          return generator.throw(error)
        }
      }
    }
  }
}
