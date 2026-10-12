import { Button } from '@base-ui/react/button'
import { Input } from '@base-ui/react/input'
import { useNavigate } from '@tanstack/react-router'
import { useState } from 'react'

import type { FormEvent } from 'react'

import { authClient } from './auth'
import { Route } from './routes/login'

export const LoginFeature = () => {
  const navigate = useNavigate()
  const search = Route.useSearch()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (busy) {
      return
    }
    const form = event.currentTarget
    const token = String(new FormData(form).get('token') ?? '').trim()
    form.reset()
    setBusy(true)
    setError('')
    try {
      const result = await authClient.signInToken(token)
      if (result.error) {
        setError(result.error.status === 401 ? '访问令牌无效，请重新输入。' : '暂时无法登录，请检查服务连接后重试。')
        return
      }
      await navigate({ replace: true, search, to: '/workspace' })
    } catch {
      setError('暂时无法登录，请检查服务连接后重试。')
    } finally {
      setBusy(false)
    }
  }
  return (
    <section aria-labelledby="login-title" className="login-card">
      <div className="mb-10 flex items-center gap-3">
        <span aria-hidden="true" className="brand-mark">
          r.
        </span>
        <span className="font-semibold tracking-tight">Runtime</span>
      </div>
      <p className="eyebrow">你的专属工作空间</p>
      <h1 className="mt-3 font-semibold text-3xl tracking-tight" id="login-title">
        欢迎回来
      </h1>
      <p className="mt-4 text-sm text-stone-600 leading-7">登录工作台，让想法继续向前。</p>
      <form className="mt-9" onSubmit={submit}>
        <label className="mb-2 block font-medium text-sm" htmlFor="access-token">
          访问令牌
        </label>
        <Input
          aria-describedby="token-help login-error"
          aria-invalid={Boolean(error)}
          autoComplete="off"
          className="token-input"
          disabled={busy}
          id="access-token"
          maxLength={256}
          name="token"
          placeholder="输入访问令牌"
          required
          type="password"
        />
        <p className="mt-3 text-stone-500 text-xs leading-6" id="token-help">
          使用服务端生成的访问令牌。登录有效期为 7 天，服务重启后需重新登录。
        </p>
        <p className="mt-3 min-h-6 text-red-700 text-sm" id="login-error" role="alert">
          {error}
        </p>
        <Button className="primary-button mt-4 w-full" disabled={busy} type="submit">
          {busy ? '正在登录…' : '进入工作台'}
          <span aria-hidden="true">↗</span>
        </Button>
      </form>
      <p className="mt-8 border-stone-200 border-t pt-5 text-stone-500 text-xs">单用户 · 自托管 · 私有工作台</p>
    </section>
  )
}
