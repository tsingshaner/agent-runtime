import { Input } from '@base-ui/react/input'
import { ORPCError } from '@orpc/client'
import { Button } from '@qingshaner/ui/components/button'
import { useMutation, useMutationState, useQuery } from '@tanstack/react-query'
import { useState } from 'react'

import { api, bindProjectKnowledge, queryClient } from './api'
import { KnowledgeEditor } from './knowledge-editor'

export const KnowledgeFeature = ({ projectId }: { projectId: string }) => {
  const [directory, setDirectory] = useState('')
  const binding = useQuery({
    queryFn: ({ signal }) => api.knowledge.binding({ params: { id: projectId } }, { signal }),
    queryKey: ['knowledge-binding', projectId]
  })
  const updates = useMutationState({
    filters: { mutationKey: ['knowledge-bind', projectId] },
    select: (mutation) => mutation.state
  })
  const pending = updates.some((update) => update.status === 'pending')
  const update = useMutation({
    mutationFn: () => bindProjectKnowledge({ body: { directory: directory.trim() }, params: { id: projectId } }),
    mutationKey: ['knowledge-bind', projectId],
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['knowledge-binding', projectId] })
  })
  const unbound = binding.error instanceof ORPCError && binding.error.data?.code === 'NOT_BOUND'
  return (
    <section aria-labelledby="knowledge-title" className="mt-8 min-w-0 space-y-4">
      <h2 className="font-semibold text-xl" id="knowledge-title">
        项目知识
      </h2>
      {binding.isPending && <p role="status">正在加载知识绑定…</p>}
      {unbound && <p>本项目尚未绑定知识目录。请填写服务器上已有的 Markdown 目录。</p>}
      {binding.isError && !unbound && (
        <p role="alert">
          知识绑定加载失败。<Button onClick={() => binding.refetch()}>重试绑定</Button>
        </p>
      )}
      {binding.data && <p className="break-all">当前服务端目录：{binding.data.directory}</p>}
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault()
          if (!pending && directory.trim()) update.mutate()
        }}
      >
        <label htmlFor="knowledge-directory">服务端知识目录</label>
        <Input
          className="token-input w-full"
          disabled={pending}
          id="knowledge-directory"
          onChange={(event) => setDirectory(event.target.value)}
          required
          value={directory}
        />
        <p className="text-sm">目录必须已存在，不会自动创建；更换绑定不会移动或删除原文档。</p>
        <Button disabled={pending || !directory.trim()} type="submit">
          绑定知识目录
        </Button>
      </form>
      {pending && <p role="status">正在提交知识绑定；如有活动运行，将等待其结束。可以切换页面处理运行。</p>}
      {updates.at(-1)?.status === 'error' && <p role="alert">绑定失败，请检查服务端目录和访问权限。输入已保留。</p>}
      {binding.data && (
        <KnowledgeDocuments
          directory={binding.data.directory}
          key={binding.data.directory}
          locked={pending || !binding.isSuccess}
          projectId={projectId}
        />
      )}
    </section>
  )
}

const KnowledgeDocuments = ({
  projectId,
  directory,
  locked
}: {
  projectId: string
  directory: string
  locked: boolean
}) => {
  const [selected, setSelected] = useState<string>()
  const [query, setQuery] = useState('')
  const [search, setSearch] = useState('')
  const key = ['knowledge', projectId, directory]
  const documents = useQuery({
    queryFn: async ({ signal }) => {
      const result = await api.knowledge.documents({ params: { id: projectId }, query: {} }, { signal })
      if (!Array.isArray(result)) throw new Error('Expected document list')
      return result
    },
    queryKey: [...key, 'list']
  })
  const matches = useQuery({
    enabled: Boolean(search),
    queryFn: ({ signal }) => api.knowledge.search({ params: { id: projectId }, query: { q: search } }, { signal }),
    queryKey: [...key, 'search', search]
  })
  return (
    <div className="space-y-4">
      <Button onClick={() => setSelected('')}>新建文档</Button>
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault()
          if (query.trim() === search && search) void matches.refetch()
          else setSearch(query.trim())
        }}
      >
        <label className="min-w-0 flex-1" htmlFor="knowledge-search">
          关键词
          <Input
            className="token-input mt-1 w-full"
            id="knowledge-search"
            onChange={(event) => setQuery(event.target.value)}
            value={query}
          />
        </label>
        <Button type="submit">搜索知识</Button>
      </form>
      {search ? (
        <section aria-label="搜索结果" className="space-y-2">
          {matches.isFetching && <p role="status">正在搜索…</p>}
          {matches.isError && <p role="alert">搜索失败，请重试。</p>}
          {matches.isSuccess && matches.data.length === 0 && <p>没有匹配的文档。</p>}
          {matches.isSuccess &&
            matches.data.map((match) => (
              <div className="min-w-0 break-all" key={match.path}>
                <Button onClick={() => setSelected(match.path)} variant="outline">
                  {match.path}
                </Button>
                <p className="whitespace-pre-wrap">{match.excerpt}</p>
              </div>
            ))}
        </section>
      ) : (
        <section aria-label="知识文档列表" className="space-y-2">
          {documents.isPending && <p role="status">正在加载文档…</p>}
          {documents.isError && (
            <p role="alert">
              文档列表加载失败。<Button onClick={() => documents.refetch()}>重试列表</Button>
            </p>
          )}
          {documents.isSuccess && documents.data.length === 0 && <p>知识目录中暂无 Markdown 文档。</p>}
          {documents.isSuccess &&
            documents.data.map((path) => (
              <div className="break-all" key={path}>
                <Button onClick={() => setSelected(path)} variant="outline">
                  {path}
                </Button>
              </div>
            ))}
        </section>
      )}
      {selected !== undefined && (
        <KnowledgeEditor
          directory={directory}
          key={selected}
          locked={locked}
          onDeleted={() => setSelected(undefined)}
          onSaved={setSelected}
          path={selected}
          projectId={projectId}
        />
      )}
    </div>
  )
}
