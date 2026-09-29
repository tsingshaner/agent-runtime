import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useState } from 'react'

import { api } from './api'
import { CreateProjectFeature } from './create-project'
import { Route } from './routes/workspace'
import { SessionFeature } from './sessions'

export const ProjectWorkspaceFeature = () => {
  const { project } = Route.useSearch()
  const [open, setOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const projects = useInfiniteQuery({
    getNextPageParam: (page: Awaited<ReturnType<typeof api.projects.list>>) => page.nextCursor ?? undefined,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) => api.projects.list({ query: { cursor: pageParam } }, { signal }),
    queryKey: ['projects']
  })
  const items = projects.data?.pages.flatMap((page) => page.items)
  const showCreate = creating || (!project && items?.length === 0)
  return (
    <div className="workspace-shell">
      <button
        aria-controls="project-navigation"
        aria-expanded={open}
        className="m-3 text-button md:hidden"
        onClick={() => setOpen(!open)}
        type="button"
      >
        {open ? '收起导航' : '展开导航'}
      </button>
      <aside className={`workspace-sidebar ${open ? '' : 'hidden md:flex'}`} id="project-navigation">
        <nav aria-label="项目" className="space-y-2">
          <h2 className="eyebrow">项目</h2>
          {projects.isPending && <p role="status">正在加载项目…</p>}
          {projects.isError && (
            <p role="alert">
              项目列表加载失败{' '}
              <button onClick={() => projects.refetch()} type="button">
                重试
              </button>
            </p>
          )}
          {items?.length === 0 && <p>暂无项目</p>}
          {items?.map((item) => (
            <Link
              className={item.id === project ? 'nav-current' : 'w-full justify-start text-button'}
              key={item.id}
              onClick={() => {
                setCreating(false)
                setOpen(false)
              }}
              search={{ project: item.id }}
              to="/workspace"
            >
              {item.name}
            </Link>
          ))}
          {projects.hasNextPage && (
            <button
              className="text-button"
              disabled={projects.isFetchingNextPage}
              onClick={() => projects.fetchNextPage()}
              type="button"
            >
              更多项目
            </button>
          )}
          <button
            className="text-button"
            onClick={() => {
              setCreating(true)
              setOpen(false)
            }}
            type="button"
          >
            新建项目
          </button>
        </nav>
        {project && <SessionNavigation key={project} onSelect={() => setOpen(false)} projectId={project} />}
      </aside>
      <main className="min-w-0 flex-1 p-6 md:p-10">
        {showCreate ? (
          <CreateProjectFeature
            first={items?.length === 0}
            onClose={() => {
              setCreating(false)
              setOpen(false)
            }}
          />
        ) : !project ? (
          <h1>选择或创建一个项目</h1>
        ) : (
          <ProjectDetail key={project} project={project} />
        )}
      </main>
    </div>
  )
}

const ProjectDetail = ({ project }: { project: string }) => {
  const selected = useQuery({
    enabled: Boolean(project),
    queryFn: ({ signal }) => api.projects.get({ params: { id: project ?? '' } }, { signal }),
    queryKey: ['project', project]
  })
  if (selected.isPending) {
    return <p role="status">正在加载项目…</p>
  }
  if (selected.isError) {
    return (
      <div role="alert">
        项目不存在或无法加载{' '}
        <button className="text-button" onClick={() => selected.refetch()} type="button">
          重试
        </button>
      </div>
    )
  }
  return (
    <section>
      <h1 className="font-semibold text-2xl">{selected.data.name}</h1>
      <p className="mt-3 text-sm text-stone-500">服务端工作目录</p>
      {selected.data.workingDirectories.map((path) => (
        <p className="break-all text-sm text-stone-600" key={path}>
          {path}
        </p>
      ))}
      <SessionFeature project={selected.data} />
    </section>
  )
}

const SessionNavigation = ({ projectId, onSelect }: { projectId: string; onSelect: () => void }) => {
  const { session } = Route.useSearch()
  const [archived, setArchived] = useState(false)
  const sessions = useInfiniteQuery({
    getNextPageParam: (page: Awaited<ReturnType<typeof api.sessions.list>>) => page.nextCursor ?? undefined,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      api.sessions.list({ query: { archived, cursor: pageParam, projectId, runtime: 'codex' } }, { signal }),
    queryKey: ['sessions', projectId, archived]
  })
  const items = sessions.data?.pages.flatMap((page) => page.items)
  return (
    <nav aria-label="会话" className="mt-8 space-y-2">
      <h2 className="eyebrow">会话</h2>
      <label className="block text-sm">
        <input checked={archived} onChange={(event) => setArchived(event.target.checked)} type="checkbox" /> 显示已归档
      </label>
      {sessions.isPending && <p role="status">正在加载会话…</p>}
      {sessions.isError && (
        <p role="alert">
          会话加载失败{' '}
          <button onClick={() => sessions.refetch()} type="button">
            重试
          </button>
        </p>
      )}
      {items?.length === 0 && <p className="text-sm text-stone-500">暂无会话</p>}
      {items?.map((item) => (
        <Link
          className={item.id === session ? 'nav-current' : 'w-full justify-start text-button'}
          key={item.id}
          onClick={onSelect}
          search={{ project: projectId, session: item.id }}
          to="/workspace"
        >
          {item.title || '未命名会话'}
        </Link>
      ))}
      {sessions.hasNextPage && (
        <button
          className="text-button"
          disabled={sessions.isFetchingNextPage}
          onClick={() => sessions.fetchNextPage()}
          type="button"
        >
          更多会话
        </button>
      )}
    </nav>
  )
}
