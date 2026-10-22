import { Input } from '@base-ui/react/input'
import { Button } from '@qingshaner/ui/components/button'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import Markdown from 'react-markdown'

import { api, queryClient } from './api'

export const KnowledgeEditor = ({
  projectId,
  directory,
  path,
  onSaved,
  onDeleted,
  locked
}: {
  locked: boolean
  projectId: string
  directory: string
  path: string
  onSaved: (path: string) => void
  onDeleted: () => void
}) => {
  const [name, setName] = useState(path)
  const [draft, setDraft] = useState<string>()
  const document = useQuery({
    enabled: Boolean(path),
    queryFn: async ({ signal }) => {
      const result = await api.knowledge.documents({ params: { id: projectId }, query: { path } }, { signal })
      if (Array.isArray(result)) throw new Error('Expected document content')
      return result.content
    },
    queryKey: ['knowledge', projectId, directory, 'document', path]
  })
  const content = draft ?? document.data ?? ''
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['knowledge', projectId, directory] })
  const save = useMutation({
    mutationFn: () =>
      (path ? api.knowledge.edit : api.knowledge.create)({
        body: { content, path: path || name.trim() },
        params: { id: projectId }
      }),
    onSuccess: async () => {
      await refresh()
      onSaved(path || name.trim())
    }
  })
  const remove = useMutation({
    mutationFn: () => api.knowledge.delete({ params: { id: projectId }, query: { path } }),
    onSuccess: async () => {
      await refresh()
      onDeleted()
    }
  })
  const pending = save.isPending || remove.isPending
  const readable = !path || document.isSuccess
  const disabled = pending || locked || !readable
  return (
    <section aria-label="知识编辑器" className="min-w-0 space-y-3">
      {document.isLoading && <p role="status">正在读取文档…</p>}
      {document.isError && (
        <p role="alert">
          读取失败，请检查路径和权限。<Button onClick={() => document.refetch()}>重试读取</Button>
        </p>
      )}
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault()
          if (!disabled) save.mutate()
        }}
      >
        <label htmlFor="knowledge-path">文档相对路径（.md）</label>
        <Input
          className="token-input w-full"
          disabled={Boolean(path) || pending}
          id="knowledge-path"
          onChange={(event) => setName(event.target.value)}
          required
          value={name}
        />
        <label className="block" htmlFor="knowledge-content">
          Markdown 内容
        </label>
        <textarea
          className="token-input min-h-64 w-full font-mono"
          disabled={disabled}
          id="knowledge-content"
          onChange={(event) => {
            setDraft(event.target.value)
            save.reset()
          }}
          value={content}
        />
        <Button disabled={disabled || !name.trim()} type="submit">
          保存文档
        </Button>
        {path && (
          <Button
            className="ml-3"
            disabled={disabled}
            onClick={() => {
              if (window.confirm(`确定删除 ${path}？文件将从服务端目录删除。`)) remove.mutate()
            }}
            variant="outline"
          >
            删除文档
          </Button>
        )}
      </form>
      {pending && <p role="status">正在提交文档变更…</p>}
      {save.isError && <p role="alert">保存失败，内容已保留。请检查路径、文件是否存在和访问权限。</p>}
      {remove.isError && <p role="alert">删除失败，文档仍保留在当前视图，请重试。</p>}
      {save.isSuccess && <p role="status">文档已保存。</p>}
      {readable && (
        <section
          aria-label="Markdown 预览"
          className="markdown min-w-0 overflow-auto break-words rounded-lg border p-4"
        >
          <Markdown components={{ img: () => null }} skipHtml>
            {content}
          </Markdown>
        </section>
      )}
    </section>
  )
}
