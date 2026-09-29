import { useMutation } from '@tanstack/react-query'

import { api, queryClient } from './api'
import { Route } from './routes/workspace'

export const CreateProjectFeature = ({ first, onClose }: { first: boolean; onClose: () => void }) => {
  const navigate = Route.useNavigate()
  const create = useMutation({
    mutationFn: (body: { name: string; workingDirectories: string[] }) => api.projects.create({ body }),
    onSuccess: async (value) => {
      queryClient.setQueryData(['project', value.id], value)
      await queryClient.invalidateQueries({ queryKey: ['projects'] })
      await navigate({ search: { project: value.id } })
      onClose()
    }
  })
  return (
    <section className="max-w-xl">
      <h1 className="font-semibold text-2xl">{first ? '创建第一个项目' : '新建项目'}</h1>
      <p className="my-4 text-stone-600">绑定服务端已有工作目录。项目归属不构成文件访问沙箱。</p>
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault()
          if (create.isPending) {
            return
          }
          const data = new FormData(event.currentTarget)
          create.mutate({
            name: String(data.get('name')).trim(),
            workingDirectories: [String(data.get('directory')).trim()]
          })
        }}
      >
        <label className="block">
          项目名称
          <input className="token-input" maxLength={200} name="name" required />
        </label>
        <label className="block">
          服务端工作目录
          <input className="token-input" name="directory" placeholder="/srv/projects/my-project" required />
        </label>
        {create.isError && <p role="alert">创建失败，请检查服务端目录是否存在、可访问及服务连接。</p>}
        <button className="primary-button" disabled={create.isPending} type="submit">
          {create.isPending ? '正在创建…' : '创建项目'}
        </button>
        {!first && (
          <button className="text-button" onClick={onClose} type="button">
            返回
          </button>
        )}
      </form>
    </section>
  )
}
