import { Input } from '@base-ui/react/input'
import { Button } from '@qingshaner/ui/components/button'
import { useMutation, useMutationState } from '@tanstack/react-query'
import { useState } from 'react'
import * as z from 'zod/mini'

import { api, queryClient } from './api'

export type McpConfig = Parameters<typeof api.mcp.create>[0]['body']
export type McpServer = Awaited<ReturnType<typeof api.mcp.get>>
const variable = z.string().check(z.regex(/^[A-Za-z_][A-Za-z0-9_]*$/))

const initialFields = (config?: McpServer) => {
  const stdio = config?.transport === 'stdio' ? config : undefined
  const http = config?.transport === 'http' ? config : undefined
  return {
    args: JSON.stringify(stdio?.args ?? []),
    command: stdio?.command ?? '',
    cwd: stdio?.cwd ?? '',
    env: JSON.stringify(stdio?.env ?? {}),
    headers: JSON.stringify(http?.headers ?? {}),
    name: config?.name ?? '',
    timeout: config?.timeoutMs ?? 10000,
    transport: config?.transport ?? ('stdio' as const),
    url: http?.url ?? ''
  }
}

export const McpEditor = ({ config }: { config?: McpServer }) => {
  const [fields, setFields] = useState(() => initialFields(config))
  const { name, transport, command, args, cwd, url, env, headers, timeout } = fields
  const [validation, setValidation] = useState('')
  const key = ['mcp-update', config?.id ?? 'new']
  const updates = useMutationState({ filters: { mutationKey: key }, select: (mutation) => mutation.state })
  const pending = updates.some((update) => update.status === 'pending')
  const latest = updates.at(-1)
  const save = useMutation({
    mutationFn: async (body: McpConfig) => {
      if (config) await api.mcp.update({ body, params: { id: config.id } })
      else await api.mcp.create({ body })
    },
    mutationKey: key,
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['mcp'] }),
        queryClient.invalidateQueries({ queryKey: ['project-mcp'] })
      ])
    }
  })
  return (
    <form
      aria-label="MCP 配置"
      className="mt-6 space-y-3"
      onSubmit={(event) => {
        event.preventDefault()
        if (pending) return
        setValidation('')
        try {
          const common = { name: name.trim(), timeoutMs: timeout }
          const body: McpConfig =
            transport === 'stdio'
              ? {
                  ...common,
                  args: z.parse(z.array(z.string()), JSON.parse(args)),
                  command: command.trim(),
                  cwd: cwd.trim() || undefined,
                  env: z.parse(z.record(variable, variable), JSON.parse(env)),
                  transport
                }
              : {
                  ...common,
                  headers: z.parse(
                    z.record(z.string().check(z.regex(/^[A-Za-z0-9-]+$/)), variable),
                    JSON.parse(headers)
                  ),
                  transport,
                  url: url.trim()
                }
          save.mutate(body)
        } catch {
          setValidation('参数必须是 JSON 字符串数组；凭据映射必须是 JSON 对象，值只能填写服务端环境变量名。')
        }
      }}
    >
      <h3 className="font-semibold">{config ? `编辑 ${config.name}` : '新建 MCP 服务'}</h3>
      {config && <p>这是共享配置，保存会影响所有绑定项目；有活动运行时将等待其结束。</p>}
      <fieldset className="min-w-0 space-y-3" disabled={pending}>
        <label className="block" htmlFor="mcp-name">
          服务名称
          <Input
            className="token-input mt-1 w-full"
            id="mcp-name"
            onChange={(event) => setFields({ ...fields, name: event.target.value })}
            pattern="[A-Za-z0-9_-]+"
            required
            value={name}
          />
        </label>
        <label className="block">
          传输方式
          <select
            className="token-input mt-1 w-full"
            onChange={(event) => setFields({ ...fields, transport: event.target.value === 'http' ? 'http' : 'stdio' })}
            value={transport}
          >
            <option value="stdio">stdio</option>
            <option value="http">Streamable HTTP</option>
          </select>
        </label>
        {transport === 'stdio' ? (
          <>
            <label className="block" htmlFor="mcp-command">
              启动命令
              <Input
                className="token-input mt-1 w-full"
                id="mcp-command"
                onChange={(event) => setFields({ ...fields, command: event.target.value })}
                required
                value={command}
              />
            </label>
            <div>
              <label className="block" htmlFor="mcp-args">
                参数（JSON 数组）
              </label>
              <textarea
                className="token-input mt-1 w-full"
                id="mcp-args"
                onChange={(event) => setFields({ ...fields, args: event.target.value })}
                required
                value={args}
              />
            </div>
            <label className="block" htmlFor="mcp-cwd">
              服务端工作目录（可选）
              <Input
                className="token-input mt-1 w-full"
                id="mcp-cwd"
                onChange={(event) => setFields({ ...fields, cwd: event.target.value })}
                value={cwd}
              />
            </label>
            <div>
              <label className="block" htmlFor="mcp-env">
                环境变量引用（JSON 对象）
              </label>
              <textarea
                className="token-input mt-1 w-full"
                id="mcp-env"
                onChange={(event) => setFields({ ...fields, env: event.target.value })}
                required
                value={env}
              />
            </div>
            <p className="text-sm text-stone-600">
              键为子进程变量名，值为服务端环境变量名，例如 {`{"TOKEN":"MCP_TOKEN"}`}。不要在参数中填写密钥。
            </p>
          </>
        ) : (
          <>
            <label className="block" htmlFor="mcp-url">
              服务 URL
              <Input
                className="token-input mt-1 w-full"
                id="mcp-url"
                onChange={(event) => setFields({ ...fields, url: event.target.value })}
                required
                type="url"
                value={url}
              />
            </label>
            <p className="text-sm text-stone-600">URL 不允许嵌入凭据、查询参数或片段。</p>
            <div>
              <label className="block" htmlFor="mcp-headers">
                请求头环境变量引用（JSON 对象）
              </label>
              <textarea
                className="token-input mt-1 w-full"
                id="mcp-headers"
                onChange={(event) => setFields({ ...fields, headers: event.target.value })}
                required
                value={headers}
              />
            </div>
            <p className="text-sm text-stone-600">
              例如 {`{"Authorization":"MCP_AUTH_HEADER"}`}。值只能是服务端环境变量名，不是密钥。
            </p>
          </>
        )}
        <label className="block" htmlFor="mcp-timeout">
          超时（毫秒）
          <Input
            className="token-input mt-1 w-full"
            id="mcp-timeout"
            max={120000}
            min={10}
            onChange={(event) => setFields({ ...fields, timeout: Number(event.target.value) })}
            required
            type="number"
            value={timeout}
          />
        </label>
        <Button type="submit">{config ? '保存共享配置' : '创建 MCP 服务'}</Button>
      </fieldset>
      {pending && <p role="status">正在提交配置；如有活动运行，将等待其结束。可以切换页面处理运行。</p>}
      {validation && <p role="alert">{validation}</p>}
      {latest?.status === 'error' && <p role="alert">保存失败，请检查配置格式、URL 和服务连接后重试。输入已保留。</p>}
      {latest?.status === 'success' && !validation && (
        <p role="status">配置已保存。连接可用性请通过「检测连接」确认。</p>
      )}
    </form>
  )
}
