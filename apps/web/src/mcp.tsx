import { ORPCError } from '@orpc/client'
import { Button } from '@qingshaner/ui/components/button'
import { useMutation, useMutationState, useQuery } from '@tanstack/react-query'
import { useState } from 'react'

import { api, bindProjectMcp, queryClient } from './api'
import { McpEditor } from './mcp-form'

import type { McpServer } from './mcp-form'

const probeError = (error: unknown) => {
  const code = error instanceof ORPCError ? error.data?.code : undefined
  if (code === 'MISSING_CREDENTIAL') return '缺少服务端环境变量，请让部署者配置凭据引用后重试。'
  if (code === 'MCP_TIMEOUT') return '连接检测超时，请检查服务地址和超时设置。'
  if (code === 'MCP_CLOSE_FAILED') return '连接释放失败，本次检测未成功完成。'
  return '连接检测失败，请检查服务地址、启动命令、权限或网络。'
}

export const McpFeature = ({ projectId }: { projectId: string }) => {
  const [editing, setEditing] = useState<string>()
  const catalog = useQuery({ queryFn: ({ signal }) => api.mcp.list(undefined, { signal }), queryKey: ['mcp'] })
  const bindings = useQuery({
    queryFn: ({ signal }) => api.projects.mcp.list({ params: { id: projectId } }, { signal }),
    queryKey: ['project-mcp', projectId]
  })
  const updates = useMutationState({
    filters: { mutationKey: ['mcp-binding', projectId] },
    select: (mutation) => mutation.state
  })
  const pending = updates.some((update) => update.status === 'pending')
  const latest = updates.at(-1)
  const binding = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean | null }) =>
      enabled === null
        ? api.projects.mcp.unbind({ params: { id: projectId, item: id } })
        : bindProjectMcp({ body: { enabled }, params: { id: projectId, item: id } }),
    mutationKey: ['mcp-binding', projectId],
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['project-mcp', projectId] })
  })
  const config = catalog.data?.find(({ id }) => id === editing)
  return (
    <section aria-labelledby="mcp-title" className="mt-8 space-y-6">
      <h2 className="font-semibold text-xl" id="mcp-title">
        MCP 服务
      </h2>
      <Button onClick={() => setEditing('new')}>新建 MCP 配置</Button>
      {editing === 'new' || config ? <McpEditor config={config} key={editing} /> : null}
      <section aria-labelledby="mcp-bindings-title" className="space-y-3">
        <h3 className="font-semibold" id="mcp-bindings-title">
          当前项目 MCP 绑定
        </h3>
        <p>仅启用的绑定供本项目使用，不继承全局 MCP。</p>
        {pending && <p role="status">正在提交 MCP 绑定变更；如有活动运行，将等待其结束。可以切换页面处理运行。</p>}
        {latest?.status === 'error' && <p role="alert">绑定变更失败，请检查配置和服务连接后重试。</p>}
        {bindings.isPending && <p role="status">正在加载 MCP 绑定…</p>}
        {bindings.isError && (
          <p role="alert">
            MCP 绑定加载失败。
            <Button onClick={() => bindings.refetch()} variant="outline">
              重试绑定
            </Button>
          </p>
        )}
        {bindings.isSuccess && bindings.data.length === 0 && <p>本项目尚未绑定 MCP 服务。</p>}
        {bindings.data?.map((server) => (
          <article aria-label={`项目 MCP ${server.name}`} className="space-y-2 rounded-lg border p-4" key={server.id}>
            <h4 className="break-all font-medium">{server.name}</h4>
            <p>{server.enabled ? '已启用' : '已停用'}</p>
            <div className="flex flex-wrap gap-2">
              <Button
                disabled={pending || bindings.isError}
                onClick={() => binding.mutate({ enabled: !server.enabled, id: server.id })}
                variant="outline"
              >
                {server.enabled ? '停用' : '启用'}
              </Button>
              <Button
                disabled={pending || bindings.isError}
                onClick={() => binding.mutate({ enabled: null, id: server.id })}
                variant="outline"
              >
                解除绑定
              </Button>
            </div>
          </article>
        ))}
      </section>
      <section aria-labelledby="mcp-catalog-title" className="space-y-3">
        <h3 className="font-semibold" id="mcp-catalog-title">
          共享 MCP 配置
        </h3>
        <p>配置由所有绑定项目共用；凭据只引用服务端环境变量，不在浏览器保存密钥。</p>
        {catalog.isPending && <p role="status">正在加载 MCP 配置…</p>}
        {catalog.isError && (
          <p role="alert">
            MCP 配置加载失败。
            <Button onClick={() => catalog.refetch()} variant="outline">
              重试配置列表
            </Button>
          </p>
        )}
        {catalog.isSuccess && catalog.data.length === 0 && <p>暂无 MCP 配置。</p>}
        {catalog.data?.map((server) => (
          <article aria-label={`共享 MCP ${server.name}`} className="space-y-3 rounded-lg border p-4" key={server.id}>
            <h4 className="break-all font-medium">{server.name}</h4>
            <p className="break-all text-sm">
              {server.transport === 'stdio' ? `stdio：${server.command}` : `Streamable HTTP：${server.url}`}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => setEditing(server.id)} variant="outline">
                查看和编辑
              </Button>
              {bindings.data?.some(({ id }) => id === server.id) ? (
                <span>已绑定当前项目</span>
              ) : (
                <Button
                  disabled={pending || !bindings.isSuccess}
                  onClick={() => binding.mutate({ enabled: true, id: server.id })}
                >
                  绑定并启用
                </Button>
              )}
            </div>
            <McpProbe config={server} />
          </article>
        ))}
      </section>
    </section>
  )
}

const McpProbe = ({ config }: { config: McpServer }) => {
  const probe = useQuery({
    enabled: false,
    queryFn: () => api.mcp.probe({ body: {}, params: { id: config.id } }),
    queryKey: ['mcp-probe', config],
    retry: false
  })
  return (
    <div className="space-y-2">
      <Button disabled={probe.isFetching} onClick={() => probe.refetch()} variant="outline">
        {probe.isFetching ? '正在检测…' : '检测连接'}
      </Button>
      {probe.isFetching ? (
        <p role="status">正在连接并发现工具…</p>
      ) : probe.isError ? (
        <p role="alert">{probeError(probe.error)}</p>
      ) : probe.isSuccess ? (
        <>
          <p role="status">连接成功，发现 {probe.data.length} 个工具。</p>
          <ul aria-label="发现的工具" className="space-y-2">
            {probe.data.map((tool) => (
              <li className="break-words text-sm" key={tool.name}>
                <strong>{tool.name}</strong>
                {tool.description && <p>{tool.description}</p>}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  )
}
