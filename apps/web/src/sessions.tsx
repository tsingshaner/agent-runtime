import { useMutation, useQuery } from '@tanstack/react-query'
import { useState } from 'react'

import type { RuntimeContractClient } from '@qingshaner/runtime-contract'

import { api, queryClient } from './api'
import { ChatFeature } from './chat'
import { Route } from './routes/workspace'

type Project = Awaited<ReturnType<RuntimeContractClient['projects']['get']>>

export const SessionFeature = ({ project }: { project: Project }) => {
  const { session } = Route.useSearch()
  const navigate = Route.useNavigate()
  const [creating, setCreating] = useState(false)
  const defaults = useQuery({ queryFn: ({ signal }) => api.health(undefined, { signal }), queryKey: ['health'] })
  const create = useMutation({
    mutationFn: (body: { title?: string; model: string; cwd: string }) =>
      api.sessions.create({ body: { ...body, projectId: project.id, runtime: 'codex' } }),
    onSuccess: async (value) => {
      await queryClient.invalidateQueries({ queryKey: ['sessions', project.id] })
      setCreating(false)
      await navigate({ search: { project: project.id, session: value.id } })
    }
  })
  return (
    <div className="mt-6">
      <button
        className="text-button"
        onClick={() => {
          setCreating(true)
          create.reset()
        }}
        type="button"
      >
        新建会话
      </button>
      {creating ? (
        <form
          className="max-w-xl space-y-4"
          onSubmit={(event) => {
            event.preventDefault()
            if (create.isPending) {
              return
            }
            const data = new FormData(event.currentTarget)
            create.mutate({
              cwd: String(data.get('cwd')),
              model: String(data.get('model')).trim(),
              title: String(data.get('title')).trim() || undefined
            })
          }}
        >
          <h2 className="font-medium text-xl">创建 Codex 会话</h2>
          <label className="block">
            会话标题
            <input className="token-input" maxLength={200} name="title" />
          </label>
          {defaults.isPending ? (
            <p role="status">正在加载默认模型…</p>
          ) : (
            <label className="block">
              模型
              <input className="token-input" defaultValue={defaults.data?.defaultModel ?? ''} name="model" required />
            </label>
          )}
          {defaults.isError && (
            <p role="alert">
              默认模型加载失败，请手动填写模型或
              <button className="text-button" onClick={() => defaults.refetch()} type="button">
                重试
              </button>
              。
            </p>
          )}
          {!(defaults.isPending || defaults.data?.defaultModel) && (
            <p className="text-sm">部署尚未配置默认模型，请填写模型名称。</p>
          )}
          <label className="block">
            服务端会话目录
            <select className="token-input" name="cwd" required>
              {project.workingDirectories.map((path) => (
                <option key={path}>{path}</option>
              ))}
            </select>
          </label>
          {project.workingDirectories.length === 0 && <p role="alert">请先为项目绑定服务端工作目录。</p>}
          <p className="text-sm text-stone-500">创建后固定项目、Codex、模型和工作目录。</p>
          {create.isError && <p role="alert">会话创建失败，请检查模型、目录、资源配置及服务连接。</p>}
          <button
            className="primary-button"
            disabled={create.isPending || defaults.isPending || project.workingDirectories.length === 0}
            type="submit"
          >
            {create.isPending ? '正在创建…' : '创建会话'}
          </button>
          <button className="text-button" onClick={() => setCreating(false)} type="button">
            返回会话
          </button>
        </form>
      ) : session ? (
        <ChatFeature key={`${project.id}:${session}`} projectId={project.id} sessionId={session} />
      ) : (
        <p className="mt-6 text-stone-500">选择或创建会话以开始聊天。</p>
      )}
    </div>
  )
}
