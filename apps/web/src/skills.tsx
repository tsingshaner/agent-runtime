import { Input } from '@base-ui/react/input'
import { Button } from '@qingshaner/ui/components/button'
import { useMutation, useMutationState, useQuery } from '@tanstack/react-query'
import { useState } from 'react'

import { api, bindProjectSkill, queryClient } from './api'

export const SkillsFeature = ({ projectId }: { projectId: string }) => {
  const [selected, setSelected] = useState('')
  const catalog = useQuery({
    queryFn: ({ signal }) => api.skills.list(undefined, { signal }),
    queryKey: ['skills']
  })
  const bindings = useQuery({
    queryFn: ({ signal }) => api.projects.skills.list({ params: { id: projectId } }, { signal }),
    queryKey: ['project-skills', projectId]
  })
  const updates = useMutationState({
    filters: { mutationKey: ['skill-binding', projectId] },
    select: (mutation) => mutation.state
  })
  const pending = updates.some((update) => update.status === 'pending')
  const latest = updates.at(-1)
  const binding = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean | null }) =>
      enabled === null
        ? api.projects.skills.unbind({ params: { id: projectId, item: id } })
        : bindProjectSkill({ body: { enabled }, params: { id: projectId, item: id } }),
    mutationKey: ['skill-binding', projectId],
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['project-skills', projectId] })
  })
  return (
    <section aria-labelledby="skills-title" className="mt-8 space-y-6">
      <h2 className="font-semibold text-xl" id="skills-title">
        技能
      </h2>
      <ImportSkill onImported={setSelected} />
      <section aria-labelledby="skill-bindings-title" className="space-y-3">
        <h3 className="font-semibold" id="skill-bindings-title">
          当前项目绑定
        </h3>
        <p className="text-sm text-stone-600">仅启用的绑定供本项目使用，不自动继承全局技能。</p>
        {pending && <p role="status">正在提交技能变更；如有活动运行，将等待其结束。你可以切换页面处理运行。</p>}
        {latest?.status === 'error' && <p role="alert">技能变更失败，请刷新绑定状态后重试。</p>}
        {bindings.isPending && <p role="status">正在加载绑定…</p>}
        {bindings.isError && (
          <p role="alert">
            绑定加载失败。
            <Button onClick={() => bindings.refetch()} variant="outline">
              重试绑定
            </Button>
          </p>
        )}
        {bindings.isSuccess && bindings.data.length === 0 && <p>本项目尚未绑定技能。</p>}
        {bindings.data?.map((skill) => (
          <article aria-label={`项目技能 ${skill.name}`} className="space-y-2 rounded-lg border p-4" key={skill.id}>
            <h4 className="break-all font-medium">{skill.name}</h4>
            <p>{skill.enabled ? '已启用' : '已停用'}</p>
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => setSelected(skill.id)} variant="outline">
                查看内容
              </Button>
              <Button
                disabled={pending || bindings.isError}
                onClick={() => binding.mutate({ enabled: !skill.enabled, id: skill.id })}
                variant="outline"
              >
                {skill.enabled ? '停用' : '启用'}
              </Button>
              <Button
                disabled={pending || bindings.isError}
                onClick={() => binding.mutate({ enabled: null, id: skill.id })}
                variant="outline"
              >
                解除绑定
              </Button>
            </div>
          </article>
        ))}
      </section>
      <section aria-labelledby="skill-catalog-title" className="space-y-3">
        <h3 className="font-semibold" id="skill-catalog-title">
          共享技能库
        </h3>
        <p className="text-sm text-stone-600">导入的受管理副本可供多个项目绑定；解除绑定不会删除技能。</p>
        {catalog.isPending && <p role="status">正在加载技能…</p>}
        {catalog.isError && (
          <p role="alert">
            技能列表加载失败。
            <Button onClick={() => catalog.refetch()} variant="outline">
              重试技能列表
            </Button>
          </p>
        )}
        {catalog.isSuccess && catalog.data.length === 0 && <p>暂无导入的技能。</p>}
        {catalog.data?.map((skill) => (
          <article aria-label={`共享技能 ${skill.name}`} className="space-y-2 rounded-lg border p-4" key={skill.id}>
            <h4 className="break-all font-medium">{skill.name}</h4>
            <p className="break-words text-sm">{skill.description}</p>
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => setSelected(skill.id)} variant="outline">
                查看内容
              </Button>
              {bindings.data?.some(({ id }) => id === skill.id) ? (
                <span>已绑定当前项目</span>
              ) : (
                <Button
                  disabled={pending || !bindings.isSuccess}
                  onClick={() => binding.mutate({ enabled: true, id: skill.id })}
                >
                  绑定并启用
                </Button>
              )}
            </div>
          </article>
        ))}
      </section>
      {selected && <SkillDetails id={selected} key={selected} />}
    </section>
  )
}

const ImportSkill = ({ onImported }: { onImported: (id: string) => void }) => {
  const [source, setSource] = useState('')
  const importing = useMutation({
    mutationFn: () => api.skills.import({ body: { source: source.trim() } }),
    onSuccess: async (skill) => {
      await queryClient.invalidateQueries({ queryKey: ['skills'] })
      onImported(skill.id)
      setSource('')
    }
  })
  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault()
        if (!importing.isPending && source.trim()) importing.mutate()
      }}
    >
      <label className="block text-sm" htmlFor="skill-source">
        服务端技能目录
      </label>
      <Input
        className="token-input w-full"
        disabled={importing.isPending}
        id="skill-source"
        onChange={(event) => setSource(event.target.value)}
        required
        value={source}
      />
      <p className="text-sm text-stone-600">填写服务器上含 SKILL.md 的目录。导入会复制脚本和参考资料，保留源目录。</p>
      <Button disabled={importing.isPending || !source.trim()} type="submit">
        {importing.isPending ? '正在导入…' : '导入技能'}
      </Button>
      {importing.isError && <p role="alert">导入失败，请检查服务端目录、文件权限及 SKILL.md 的名称和描述。</p>}
      {importing.isSuccess && <p role="status">技能已导入受管理副本。</p>}
    </form>
  )
}

const SkillDetails = ({ id }: { id: string }) => {
  const [path, setPath] = useState('SKILL.md')
  const [requestedPath, setRequestedPath] = useState('SKILL.md')
  const detail = useQuery({
    queryFn: ({ signal }) => api.skills.get({ params: { id } }, { signal }),
    queryKey: ['skill', id]
  })
  const file = useQuery({
    queryFn: ({ signal }) => api.skills.read({ params: { id }, query: { path: requestedPath } }, { signal }),
    queryKey: ['skill-file', id, requestedPath]
  })
  return (
    <section aria-labelledby="skill-content-title" className="min-w-0 space-y-3">
      <h3 className="font-semibold" id="skill-content-title">
        技能内容
      </h3>
      {detail.isPending && <p role="status">正在加载详情…</p>}
      {detail.isError && (
        <p role="alert">
          技能详情加载失败。
          <Button onClick={() => detail.refetch()} variant="outline">
            重试详情
          </Button>
        </p>
      )}
      {detail.data && (
        <>
          <p className="break-all">{detail.data.name}</p>
          <p className="break-all text-sm">受管理目录：{detail.data.directory}</p>
        </>
      )}
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault()
          if (path.trim() === requestedPath) void file.refetch()
          else setRequestedPath(path.trim())
        }}
      >
        <label className="min-w-0 flex-1 text-sm" htmlFor="skill-file">
          文件相对路径
          <Input
            className="token-input mt-2 w-full"
            id="skill-file"
            onChange={(event) => setPath(event.target.value)}
            required
            value={path}
          />
        </label>
        <Button disabled={!path.trim()} type="submit" variant="outline">
          读取文件
        </Button>
      </form>
      <p className="text-sm text-stone-600">只读展示，不执行脚本。可输入 references/guide.md 等附属资料路径。</p>
      {file.isFetching && <p role="status">正在读取文件…</p>}
      {file.isError && <p role="alert">文件读取失败，请检查相对路径和访问权限。</p>}
      {file.isSuccess && (
        <section
          aria-label={`文件内容 ${requestedPath}`}
          className="max-h-96 overflow-auto rounded-lg border p-4 text-sm"
        >
          <pre className="whitespace-pre-wrap break-all">{file.data.content}</pre>
        </section>
      )}
    </section>
  )
}
