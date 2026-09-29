// biome-ignore-all lint/style/useNamingConvention: Run statuses are protocol values.
import { useRef, useState } from 'react'
import Markdown from 'react-markdown'

import type { RuntimeContractClient } from '@qingshaner/runtime-contract'
import type { ToolCallState, UIMessage } from '@tanstack/ai-client'
import type { ReactNode } from 'react'

import { RunInteractions } from './interactions'
import { useChatModel } from './use-chat'
import { useRunStream } from './use-run-stream'

type Run = Awaited<ReturnType<RuntimeContractClient['runs']['get']>>
const statusLabels: Record<Run['status'], string> = {
  cancelled: '已取消',
  cancelling: '正在取消，等待执行结束',
  failed: '执行失败',
  interrupted: '执行已中断',
  running: '正在运行',
  starting: '正在启动',
  succeeded: '已完成',
  waiting_approval: '等待审批',
  waiting_input: '等待补充输入'
}

const toolStates: Record<ToolCallState, string> = {
  'approval-requested': '等待审批',
  'approval-responded': '已响应审批',
  'awaiting-input': '等待参数',
  complete: '已完成',
  error: '工具失败',
  'input-complete': '参数就绪',
  'input-streaming': '接收参数'
}

export const ChatFeature = ({ projectId, sessionId }: { projectId: string; sessionId: string }) => {
  const { session, runs, composer, archive } = useChatModel(projectId, sessionId)
  if (session.isPending) {
    return <p role="status">正在加载会话…</p>
  }
  if (session.isError) {
    return (
      <p role="alert">
        会话不存在、不属于当前项目或无法加载。
        <button className="text-button" onClick={() => session.refetch()} type="button">
          重试
        </button>
      </p>
    )
  }
  const busy = Boolean(session.data.activeRunId) || composer.submit.isPending
  return (
    <section className="mt-4 max-w-4xl">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold text-xl">{session.data.title || '未命名会话'}</h2>
        <button
          className="text-button"
          disabled={busy || archive.isPending || Boolean(composer.pending)}
          onClick={() => archive.mutate()}
          type="button"
        >
          {session.data.archived ? '恢复会话' : '归档会话'}
        </button>
      </div>
      <p className="break-all text-stone-500 text-xs">
        Codex · {session.data.model} · {session.data.cwd}
      </p>
      {archive.isError && <p role="alert">归档操作失败，请检查运行状态后重试。</p>}
      {runs.isPending && <p role="status">正在加载历史…</p>}
      {runs.isError && (
        <p role="alert">
          历史加载失败{' '}
          <button className="text-button" onClick={() => runs.refetch()} type="button">
            重试
          </button>
        </p>
      )}
      {runs.hasNextPage && (
        <button
          className="text-button"
          disabled={runs.isFetchingNextPage}
          onClick={() => runs.fetchNextPage()}
          type="button"
        >
          更早的消息
        </button>
      )}
      <div className="space-y-6 py-6">
        {runs.data?.pages
          .flatMap((page) => page.items)
          .toReversed()
          .map((run) => (
            <RunFeature key={run.id} run={run} />
          ))}
      </div>
      <form
        className="space-y-3 border-stone-200 border-t pt-4"
        onSubmit={(event) => {
          event.preventDefault()
          composer.send()
        }}
      >
        <label className="block">
          消息
          <textarea
            className="token-input min-h-28 py-3"
            disabled={busy || Boolean(composer.pending) || session.data.archived}
            onChange={(event) => composer.setText(event.target.value)}
            required
            value={composer.text}
          />
        </label>
        {composer.error && <p role="alert">{composer.error}</p>}
        {composer.pending ? (
          <>
            <p className="text-sm">保留了原请求标识；确认原请求不会创建重复运行。</p>
            <button
              className="primary-button"
              disabled={composer.submit.isPending}
              onClick={composer.send}
              type="button"
            >
              确认原请求
            </button>
          </>
        ) : (
          <button
            className="primary-button"
            disabled={busy || session.data.archived || runs.isPending || runs.isError || !composer.text.trim()}
            type="submit"
          >
            发送
          </button>
        )}
        {busy && <p role="status">本会话运行中，结束后可再次发送。</p>}
      </form>
    </section>
  )
}

const RunFeature = ({ run }: { run: Run }) => {
  const stream = useRunStream(run.id, run.eventsCleared)
  return (
    <article className="space-y-3 rounded-xl border border-stone-200 bg-white p-4">
      {run.requestText && (
        <p className="whitespace-pre-wrap break-words rounded-lg bg-stone-100 p-3">{run.requestText}</p>
      )}
      <p className="text-sm text-teal-800" role="status">
        {statusLabels[run.status]}
      </p>
      {run.error && (
        <p role="alert">
          {run.error.message}（{run.error.code}）
        </p>
      )}
      {run.eventsCleared && <p>此运行的事件历史已清除。</p>}
      {stream.error && (
        <p role="alert">
          {stream.error}
          <button className="text-button" onClick={stream.reconnect} type="button">
            重新连接事件
          </button>
        </p>
      )}
      <RunInteractions active={!run.endedAt} cancelling={run.status === 'cancelling'} runId={run.id} />
      {stream.messages.map((message) => (
        <div className="space-y-3" key={message.id}>
          {message.parts.map((part, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: StreamProcessor parts append in stable order and text parts have no ID.
            <MessagePart key={index} part={part} />
          ))}
        </div>
      ))}
    </article>
  )
}
const MessagePart = ({ part }: { part: UIMessage['parts'][number] }) => {
  if (part.type === 'text') {
    return (
      <div className="markdown break-words">
        <Markdown components={{ img: () => null, pre: CodeBlock }} skipHtml>
          {part.content}
        </Markdown>
      </div>
    )
  }
  if (part.type === 'tool-call') {
    return (
      <details className="rounded-lg bg-stone-50 p-3" open>
        <summary>
          工具：{part.name} · {toolStates[part.state]}
        </summary>
        <pre className="whitespace-pre-wrap break-all text-xs">{part.arguments}</pre>
      </details>
    )
  }
  if (part.type === 'tool-result') {
    return (
      <pre className="whitespace-pre-wrap break-all text-xs">
        {typeof part.content === 'string' ? part.content : JSON.stringify(part.content)}
      </pre>
    )
  }
  return null
}

const CodeBlock = ({ children }: { children?: ReactNode }) => {
  const ref = useRef<HTMLPreElement>(null)
  const [label, setLabel] = useState('复制代码')
  return (
    <div className="my-3 overflow-hidden rounded-lg bg-stone-100">
      <button
        className="text-button"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(ref.current?.textContent ?? '')
            setLabel('已复制')
          } catch {
            setLabel('复制失败，请手动选择')
          }
        }}
        type="button"
      >
        {label}
      </button>
      <pre className="overflow-x-auto p-3 text-sm" ref={ref}>
        {children}
      </pre>
    </div>
  )
}
