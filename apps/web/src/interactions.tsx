import { ORPCError } from '@orpc/client'
import { useMutation, useMutationState, useQuery } from '@tanstack/react-query'
import { useState } from 'react'

import type { RuntimeContractClient } from '@qingshaner/runtime-contract'

import { api, queryClient } from './api'

type Approval = Awaited<ReturnType<RuntimeContractClient['runs']['approvals']>>[number]
type InputRequest = Awaited<ReturnType<RuntimeContractClient['runs']['inputs']>>[number]

const useInteractionAction = (request: Approval | InputRequest, refresh: () => Promise<unknown>) => {
  const key = `interaction:${request.id}`
  const [sent, setSent] = useState(() => {
    try {
      return sessionStorage.getItem(key) !== null
    } catch {
      return false
    }
  })
  const action = useMutation({
    mutationFn: async (operation: () => Promise<unknown>) => {
      if (sessionStorage.getItem(key)) {
        throw new Error('Already sent')
      }
      sessionStorage.setItem(key, 'sent')
      setSent(true)
      return await operation()
    },
    mutationKey: ['interaction', request.runId, request.id],
    onError: (error) => {
      if (error instanceof ORPCError && error.code === 'BAD_REQUEST') {
        sessionStorage.removeItem(key)
        setSent(false)
      }
    },
    onSettled: refresh
  })
  return { action, sent }
}

export const RunInteractions = ({
  runId,
  cancelling,
  active
}: {
  runId: string
  cancelling: boolean
  active: boolean
}) => {
  const failures = useMutationState({
    filters: { mutationKey: ['interaction', runId], status: 'error' },
    select: (mutation) => mutation.state.error
  })
  const requests = useQuery({
    enabled: active,
    queryFn: async ({ signal }) => {
      const params = { id: runId }
      const [approvals, inputs] = await Promise.all([
        api.runs.approvals({ params }, { signal }),
        api.runs.inputs({ params }, { signal })
      ])
      return { approvals, inputs }
    },
    queryKey: ['interactions', runId],
    refetchInterval: active ? 1000 : false
  })
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['interactions', runId] })
  const cancel = useMutation({
    mutationFn: () => api.runs.cancel({ params: { id: runId } }),
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: ['runs'] })
      await refresh()
    }
  })
  if (!active) {
    const failure = failures.at(-1)
    if (!failure) return null
    return (
      <p role="alert">
        {failure instanceof ORPCError && failure.code === 'CONFLICT'
          ? '交互已过期或已处理，提交被拒绝。'
          : '此前交互提交结果不确定，请以服务端记录为准。'}
      </p>
    )
  }
  return (
    <section aria-label="运行控制" className="space-y-3 border-stone-200 border-t pt-3">
      {requests.isPending && <p role="status">正在查询待处理交互…</p>}
      {requests.isError && (
        <p role="alert">
          交互加载失败{' '}
          <button className="text-button" onClick={() => requests.refetch()} type="button">
            刷新交互
          </button>
        </p>
      )}
      {requests.data?.approvals.map((request) => (
        <ApprovalFeature disabled={cancelling} key={request.id} refresh={refresh} request={request} />
      ))}
      {requests.data?.inputs.map((request) => (
        <InputFeature disabled={cancelling} key={request.id} refresh={refresh} request={request} />
      ))}
      <button
        className="text-button"
        disabled={cancelling || cancel.isPending || cancel.isSuccess}
        onClick={() => cancel.mutate()}
        type="button"
      >
        取消运行
      </button>
      {cancel.isSuccess && <p role="status">取消请求已发送，等待服务端确认终态。</p>}
      {cancel.isError && <p role="alert">取消请求未确认，请检查运行状态后重试。</p>}
    </section>
  )
}

const ApprovalFeature = ({
  request,
  refresh,
  disabled
}: {
  request: Approval
  refresh: () => Promise<unknown>
  disabled: boolean
}) => {
  const { action, sent } = useInteractionAction(request, refresh)
  return (
    <section aria-label="审批" className="rounded-lg border border-amber-200 p-3">
      <h3 className="font-medium">操作审批 · {request.kind}</h3>
      {request.batchId && (
        <p className="break-all text-xs">
          审批批次 {request.batchId} · 第 {(request.batchIndex ?? 0) + 1} 项，收齐决定后执行。
        </p>
      )}
      <pre className="whitespace-pre-wrap break-all text-xs">{JSON.stringify(request.detail, null, 2)}</pre>
      {request.decision ? (
        <p>
          已决定：{request.decision === 'approve' ? '批准' : '拒绝'}，
          {request.status === 'decided' ? '等待批次收齐' : '等待执行确认'}
        </p>
      ) : (
        request.allowedDecisions.map((decision) => (
          <button
            className="text-button"
            disabled={disabled || sent || action.isPending || request.status !== 'pending'}
            key={decision}
            onClick={() =>
              action.mutate(() =>
                api.runs.approve({ body: { decision }, params: { id: request.runId, item: request.id } })
              )
            }
            type="button"
          >
            {decision === 'approve' ? '批准' : '拒绝'}
          </button>
        ))
      )}
      {action.isError && <p role="alert">审批未确认、已过期或已处理。已保留操作信息，不重发授权。</p>}
      {sent && !request.decision && <p role="status">已尝试提交，等待服务端状态确认。</p>}
      <button className="text-button" onClick={refresh} type="button">
        刷新交互状态
      </button>
    </section>
  )
}

const InputFeature = ({
  request,
  refresh,
  disabled
}: {
  request: InputRequest
  refresh: () => Promise<unknown>
  disabled: boolean
}) => {
  const { action, sent } = useInteractionAction(request, refresh)
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const blocked = disabled || sent || action.isPending || request.status !== 'pending'
  return (
    <form
      className="space-y-3 rounded-lg border border-teal-200 p-3"
      onSubmit={(event) => {
        event.preventDefault()
        if (blocked) {
          return
        }
        action.mutate(() =>
          api.runs.answer({
            body: {
              answers: Object.fromEntries(
                request.questions.map((question) => [question.id, [answers[question.id] ?? '']])
              )
            },
            params: { id: request.runId, item: request.id }
          })
        )
      }}
    >
      <h3 className="font-medium">补充输入</h3>
      {request.questions.map((question) => (
        <fieldset disabled={blocked} key={question.id}>
          <legend className="text-sm">{question.header}</legend>
          <label className="block">
            {question.question}
            <input
              autoComplete="off"
              className="token-input"
              onChange={(event) => setAnswers({ ...answers, [question.id]: event.target.value })}
              required
              type={question.isSecret ? 'password' : 'text'}
              value={answers[question.id] ?? ''}
            />
          </label>
          {question.options?.map((option) => (
            <button
              className="text-button"
              key={option.label}
              onClick={() => setAnswers({ ...answers, [question.id]: option.label })}
              title={option.description}
              type="button"
            >
              {option.label} · {option.description}
            </button>
          ))}
        </fieldset>
      ))}
      <button className="primary-button" disabled={blocked} type="submit">
        提交补充输入
      </button>
      {action.isError && <p role="alert">回答未确认、已过期或已处理。保留填写内容，请刷新交互状态。</p>}
      {sent && <p role="status">已尝试提交，等待服务端状态确认。</p>}
      <button className="text-button" onClick={refresh} type="button">
        刷新交互状态
      </button>
    </form>
  )
}
