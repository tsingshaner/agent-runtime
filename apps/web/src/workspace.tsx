import { Button } from '@base-ui/react/button'
import { Navigate, useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'

import { queryClient } from './api'
import { authClient } from './auth'
import { ProjectWorkspaceFeature } from './projects'
import { Route } from './routes/workspace'

export const WorkspaceFeature = () => {
  const { data: session, isPending, error: sessionError } = authClient.useSession()
  const navigate = useNavigate()
  const search = Route.useSearch()
  const [leaving, setLeaving] = useState(false)
  const [error, setError] = useState('')
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
      await navigate({ replace: true, search, to: '/login' })
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
    return <Navigate replace search={search} to="/login" />
  }
  return (
    <>
      <header className="flex items-center justify-between border-stone-200 border-b px-6 py-3">
        <span className="font-semibold">Runtime</span>
        <Button className="text-button" disabled={leaving} onClick={logout}>
          {leaving ? '正在退出…' : '退出登录'}
        </Button>
      </header>
      {error && <p role="alert">{error}</p>}
      <ProjectWorkspaceFeature />
    </>
  )
}
