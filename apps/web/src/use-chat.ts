import { ORPCError } from '@orpc/client'
import { useInfiniteQuery, useMutation, useQuery } from '@tanstack/react-query'
import { useState } from 'react'

import { api, queryClient } from './api'

export const useChatModel = (projectId: string, sessionId: string) => {
  const storageKey = `pending-run:${sessionId}`
  const [pending, setPending] = useState<{ requestId: string; text: string } | null>(() => {
    try {
      const stored = JSON.parse(sessionStorage.getItem(storageKey) ?? 'null')
      return stored && typeof stored.requestId === 'string' && typeof stored.text === 'string' ? stored : null
    } catch {
      return null
    }
  })
  const [text, setText] = useState(pending?.text ?? '')
  const [error, setError] = useState('')
  const session = useQuery({
    queryFn: async ({ signal }) => {
      const value = await api.sessions.get({ params: { id: sessionId } }, { signal })
      if (value.projectId !== projectId || value.runtime !== 'codex') {
        throw new Error('Session is outside this project')
      }
      return value
    },
    queryKey: ['session', projectId, sessionId],
    refetchInterval: 1500
  })
  const runs = useInfiniteQuery({
    enabled: Boolean(session.data),
    getNextPageParam: (page: Awaited<ReturnType<typeof api.sessions.runs>>) => page.nextCursor ?? undefined,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      api.sessions.runs({ params: { id: sessionId }, query: { cursor: pageParam } }, { signal }),
    queryKey: ['runs', projectId, sessionId],
    refetchInterval: 1500
  })
  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['session', projectId, sessionId] }),
      queryClient.invalidateQueries({ queryKey: ['runs', projectId, sessionId] }),
      queryClient.invalidateQueries({ queryKey: ['sessions', projectId] })
    ])
  }
  const submit = useMutation({
    mutationFn: (body: { text: string; requestId: string }) => api.sessions.run({ body, params: { id: sessionId } }),
    onError: (failure) => {
      if (
        failure instanceof ORPCError &&
        ['BAD_REQUEST', 'UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND', 'CONFLICT', 'UNPROCESSABLE_CONTENT'].includes(
          failure.code
        )
      ) {
        sessionStorage.removeItem(storageKey)
        setPending(null)
        setError(`发送被拒绝（${failure.code}），请检查会话状态与资源配置。`)
      } else {
        setError('发送结果不确定')
      }
      void refresh()
    },
    onSuccess: async () => {
      sessionStorage.removeItem(storageKey)
      setPending(null)
      setText('')
      setError('')
      await refresh()
    }
  })
  const send = () => {
    if (submit.isPending || (!pending && (session.data?.activeRunId || !text.trim()))) {
      return
    }
    const body = pending ?? { requestId: crypto.randomUUID(), text: text.trim() }
    try {
      sessionStorage.setItem(storageKey, JSON.stringify(body))
    } catch {
      setError('无法保存请求标识，请允许会话存储后重试。')
      return
    }
    setPending(body)
    setError('')
    submit.mutate(body)
  }
  const archive = useMutation({
    mutationFn: () =>
      (session.data?.archived ? api.sessions.unarchive : api.sessions.archive)({ params: { id: sessionId } }),
    onSuccess: refresh
  })
  return { archive, composer: { error, pending, send, setText, submit, text }, runs, session }
}
