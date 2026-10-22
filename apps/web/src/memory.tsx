import { Input } from '@base-ui/react/input'
import { ORPCError } from '@orpc/client'
import { Button } from '@qingshaner/ui/components/button'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useState } from 'react'

import { api, queryClient } from './api'

const memoryFailure = (error: unknown) => {
  const code = error instanceof ORPCError ? error.data?.code : undefined
  if (code === 'RESOURCE_UNAVAILABLE')
    return 'Memory 未配置。请由部署者在服务端配置 MEMORY_ENDPOINT 和 MEMORY_API_KEY，然后重启服务。不要在网页填写密钥。'
  if (code === 'MISSING_CREDENTIAL') return 'Memory 已配置，但服务端凭据不可用。请部署者检查 MEMORY_API_KEY。'
  return 'Memory 服务不可用或查询失败，请检查服务端连接后重试。'
}

export const MemoryFeature = ({ projectId }: { projectId: string }) => (
  <section aria-labelledby="memory-title" className="mt-8 min-w-0 space-y-6">
    <h2 className="font-semibold text-xl" id="memory-title">
      项目记忆
    </h2>
    <p>删除记忆不会删除 Session 历史，也不能阻止未来新对话形成类似记忆。</p>
    <MemoryRecords projectId={projectId} />
    <MemoryWrites projectId={projectId} />
  </section>
)

const MemoryRecords = ({ projectId }: { projectId: string }) => {
  const [input, setInput] = useState('')
  const [search, setSearch] = useState('')
  const [offset, setOffset] = useState(0)
  const records = useQuery({
    queryFn: async ({ signal }) =>
      search
        ? {
            ...(await api.memory.search({ params: { id: projectId }, query: { q: search } }, { signal })),
            total: undefined
          }
        : api.memory.query({ params: { id: projectId }, query: { limit: 20, offset } }, { signal }),
    queryKey: ['memory', projectId, search, offset]
  })
  const remove = useMutation({
    mutationFn: (id: string) => api.memory.delete({ body: { ids: [id] }, params: { id: projectId } }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['memory', projectId] })
  })
  return (
    <section aria-label="记忆记录" className="space-y-3">
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault()
          const next = input.trim()
          if (next === search && offset === 0) void records.refetch()
          setSearch(next)
          setOffset(0)
        }}
      >
        <label className="min-w-0 flex-1" htmlFor="memory-search">
          记忆关键词
          <Input
            className="token-input mt-1 w-full"
            id="memory-search"
            onChange={(event) => setInput(event.target.value)}
            value={input}
          />
        </label>
        <Button type="submit">搜索记忆</Button>
        <Button onClick={() => records.refetch()} variant="outline">
          刷新记忆
        </Button>
      </form>
      {records.isFetching && <p role="status">正在查询记忆…</p>}
      {records.isError && <p role="alert">{memoryFailure(records.error)}</p>}
      {records.isSuccess && records.data.items.length === 0 && (
        <p>{search ? '没有匹配的记忆。' : '当前页暂无记忆。'}</p>
      )}
      {remove.isPending && <p role="status">正在删除记忆…</p>}
      {remove.isError && <p role="alert">删除未确认，请刷新记忆核对状态后重试。</p>}
      {remove.isSuccess && <p role="status">服务端确认删除 {remove.data.deleted_count} 条记忆。</p>}
      {records.isSuccess &&
        records.data.items.map((item) => (
          <article
            aria-label={`记忆 ${item.id}`}
            className="min-w-0 space-y-2 break-all rounded-lg border p-4"
            key={item.id}
          >
            <p className="whitespace-pre-wrap">{item.content}</p>
            <p className="text-sm">
              类型：{item.type} · ID：{item.id}
            </p>
            {item.background && <p className="whitespace-pre-wrap text-sm">来源背景：{item.background}</p>}
            <p className="text-sm">
              创建：{item.created_at} · 更新：{item.updated_at}
            </p>
            <Button
              disabled={remove.isPending}
              onClick={() => {
                if (window.confirm('确定删除这条记忆？Session 历史仍保留，未来对话可能形成类似记忆。'))
                  remove.mutate(item.id)
              }}
              variant="outline"
            >
              删除记忆
            </Button>
          </article>
        ))}
      {!search && (
        <nav aria-label="记忆分页" className="flex gap-3">
          <Button
            disabled={offset === 0 || records.isFetching}
            onClick={() => setOffset(Math.max(0, offset - 20))}
            variant="outline"
          >
            上一页记忆
          </Button>
          <Button
            disabled={!records.isSuccess || records.isFetching || offset + 20 >= (records.data?.total ?? 0)}
            onClick={() => setOffset(offset + 20)}
            variant="outline"
          >
            下一页记忆
          </Button>
        </nav>
      )}
    </section>
  )
}

const writeStatus = { accepted: '已接受', failed: '写入失败', pending: '等待写入', unknown: '结果未知' }

const MemoryWrites = ({ projectId }: { projectId: string }) => {
  const writes = useQuery({
    queryFn: ({ signal }) => api.projects.memoryWrites({ params: { id: projectId } }, { signal }),
    queryKey: ['memory-writes', projectId],
    refetchInterval: (query) => (query.state.data?.some((write) => write.status === 'pending') ? 2000 : false)
  })
  return (
    <section aria-labelledby="memory-writes-title" className="space-y-3">
      <h3 className="font-semibold" id="memory-writes-title">
        Memory Write 写入记录
      </h3>
      <p>聊天成功与记忆写入独立。「已接受」不表示已生成记忆；结果未知时不会自动补写。</p>
      <Button onClick={() => writes.refetch()} variant="outline">
        刷新写入状态
      </Button>
      {writes.isFetching && <p role="status">正在查询写入状态…</p>}
      {writes.isError && <p role="alert">写入记录查询失败，请重试。</p>}
      {writes.isSuccess && writes.data.length === 0 && <p>本项目暂无写入记录。</p>}
      {writes.isSuccess &&
        writes.data.map((write) => (
          <article
            aria-label={`写入 ${write.runId}`}
            className="min-w-0 space-y-2 break-all rounded-lg border p-4"
            key={write.runId}
          >
            <p>
              {writeStatus[write.status]}（{write.status}）
            </p>
            <p className="text-sm">
              Run：{write.runId} · Session：{write.sessionId}
            </p>
            {write.error && (
              <p>
                原因：{write.error.code} · {write.error.message}
              </p>
            )}
            <details>
              <summary>本次对话</summary>
              <p className="whitespace-pre-wrap">用户：{write.user}</p>
              <p className="whitespace-pre-wrap">助手：{write.assistant}</p>
            </details>
          </article>
        ))}
    </section>
  )
}
