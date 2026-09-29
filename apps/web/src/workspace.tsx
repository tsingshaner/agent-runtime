import { Button } from '@base-ui/react/button'
import { useQuery } from '@tanstack/react-query'
import { Navigate, useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'

import { api, queryClient } from './api'
import { authClient } from './auth'

export const WorkspaceFeature = () => {
  const { data: session, isPending, error: sessionError } = authClient.useSession()
  const navigate = useNavigate()
  const [leaving, setLeaving] = useState(false)
  const [error, setError] = useState('')
  const health = useQuery({
    enabled: Boolean(session) && !sessionError,
    queryFn: () => api.health(),
    queryKey: ['health']
  })
  useEffect(() => {
    if (!isPending && (!session || sessionError)) {
      queryClient.clear()
    }
  }, [isPending, session, sessionError])
  const logout = async () => {
    setLeaving(true)
    setError('')
    try {
      const result = await authClient.signOut()
      if (result.error) {
        throw new Error('Logout failed')
      }
      await queryClient.cancelQueries()
      queryClient.clear()
      await navigate({ replace: true, to: '/login' })
    } catch {
      setError('暂时无法退出，请检查连接后重试。')
    } finally {
      setLeaving(false)
    }
  }
  if (isPending) {
    return (
      <p className="p-8" role="status">
        正在确认登录状态…
      </p>
    )
  }
  if (sessionError) {
    return (
      <div className="p-8" role="alert">
        无法确认登录状态。
        <Button className="text-button" onClick={() => authClient.getSession()}>
          重试
        </Button>
      </div>
    )
  }
  if (!session) {
    return <Navigate replace to="/login" />
  }
  return (
    <div className="workspace-shell">
      <aside className="workspace-sidebar">
        <div className="flex items-center gap-3">
          <span aria-hidden="true" className="brand-mark">
            r.
          </span>
          <span className="font-semibold">Runtime</span>
        </div>
        <nav aria-label="主导航" className="mt-8">
          <a aria-current="page" className="nav-current" href="/workspace">
            工作台<span aria-hidden="true">↗</span>
          </a>
        </nav>
        <p className="mt-auto hidden pt-12 text-stone-500 text-xs leading-6 md:block">
          专注当下，逐步构建。
          <br />
          你的私有工作空间。
        </p>
      </aside>
      <main className="min-w-0 flex-1">
        <header className="flex flex-wrap items-center justify-between gap-4 border-stone-200 border-b px-6 py-5 md:px-12">
          <span className="text-sm text-stone-500">
            工作空间 / <span className="text-stone-900">概览</span>
          </span>
          <Button className="text-button" disabled={leaving} onClick={logout}>
            {leaving ? '正在退出…' : '退出登录'}
          </Button>
        </header>
        <div className="mx-auto max-w-4xl px-6 py-12 md:px-12 md:py-20">
          <p className="eyebrow">工作台</p>
          <h1 className="mt-4 font-semibold text-3xl tracking-tight md:text-4xl">一切就绪，从这里开始。</h1>
          <p className="mt-5 text-stone-600 leading-8">你已登录自己的 Runtime 工作台。</p>
          <section
            aria-labelledby="connection-title"
            className="mt-12 rounded-2xl border border-stone-200 bg-white p-6 md:p-8"
          >
            <div className="flex items-center justify-between gap-4">
              <h2 className="font-medium" id="connection-title">
                服务连接
              </h2>
              <span aria-hidden="true" className="h-2 w-2 rounded-full bg-teal-700" />
            </div>
            <p className="mt-4 text-sm text-stone-600" role="status">
              {health.isPending
                ? '正在连接服务…'
                : health.isError
                  ? '暂时无法访问服务，请重试或重新登录。'
                  : '受保护的服务已连接。'}
            </p>
            {health.isError && (
              <Button
                className="mt-4 text-button"
                onClick={async () => {
                  await authClient.getSession()
                  await health.refetch()
                }}
              >
                重新连接
              </Button>
            )}
          </section>
          <p className="mt-4 text-red-700 text-sm" role="alert">
            {error}
          </p>
        </div>
      </main>
    </div>
  )
}
