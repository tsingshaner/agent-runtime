// cspell:ignore enui
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { extname, join, resolve } from 'node:path'
import { Readable } from 'node:stream'

import type { ServerResponse } from 'node:http'
import { expect as browserExpect, chromium } from '@playwright/test'
import { parseEvent, RuntimeError } from '@qingshaner/runtime'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest'

import type { Browser, Page } from '@playwright/test'

import { SessionStore } from '../../../packages/runtime/src/store'
import { ManualAdapter } from '../../../packages/runtime/test/manual-adapter'
import { openTestService } from '../../server/test/service.fixture'

let browser: Browser
let page: Page
let directory: string
let service: Awaited<ReturnType<typeof openTestService>>
let origin: string
let adapter: ManualAdapter
let resumeError: RuntimeError | undefined
const streams = new Map<string, ServerResponse>()
const cursors: number[] = []
const server = createServer(async (incoming, outgoing) => {
  const stop = new AbortController()
  outgoing.on('close', () => stop.abort())
  try {
    const url = new URL(incoming.url ?? '/', origin)
    const path = url.pathname
    if (path.endsWith('/events')) {
      const runId = path.split('/')[2] ?? ''
      cursors.push(Number(url.searchParams.get('afterSequence')))
      streams.set(runId, outgoing)
      outgoing.on('close', () => {
        if (streams.get(runId) === outgoing) {
          streams.delete(runId)
        }
      })
    }
    if (path === '/' || path === '/login' || path.startsWith('/workspace') || path.startsWith('/assets/')) {
      const file = path.startsWith('/assets/') ? `dist${path}` : 'dist/index.html'
      const content = await readFile(resolve(import.meta.dirname, '..', file))
      outgoing.setHeader(
        'content-type',
        ({ '.css': 'text/css', '.js': 'text/javascript' } as Record<string, string>)[extname(file)] ?? 'text/html'
      )
      outgoing.end(content)
      return
    }
    const chunks = await Array.fromAsync(incoming)
    const body = Buffer.concat(chunks)
    const response = await service.fetch(
      new Request(`${origin}${incoming.url}`, {
        body: body.length > 0 ? body : undefined,
        headers: incoming.headers as Record<string, string>,
        method: incoming.method,
        signal: stop.signal
      })
    )
    outgoing.writeHead(response.status, Object.fromEntries(response.headers))
    if (response.body) {
      Readable.from(response.body)
        .on('error', () => outgoing.destroy())
        .pipe(outgoing)
    } else {
      outgoing.end()
    }
  } catch {
    outgoing.writeHead(500).end()
  }
})

beforeAll(async () => {
  execFileSync('pnpm', ['--filter', '@internal/web', 'build'], { stdio: 'pipe' })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Missing listener')
  }
  origin = `http://127.0.0.1:${address.port}`
  browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL, headless: true })
}, 60000)

const openService = () =>
  openTestService({
    dataDir: directory,
    defaultModel: 'deployment-model',
    origin,
    runtimes: [
      {
        cancel: adapter.cancel.bind(adapter),
        createSession: adapter.createSession.bind(adapter),
        dispose: adapter.dispose.bind(adapter),
        execute: adapter.execute.bind(adapter),
        kind: 'codex',
        respondApproval: adapter.respondApproval.bind(adapter),
        respondApprovalBatch: adapter.respondApprovalBatch.bind(adapter),
        respondInput: adapter.respondInput.bind(adapter),
        resumeSession: (session) => {
          if (resumeError) {
            return Promise.reject(resumeError)
          }
          return adapter.resumeSession(session)
        }
      }
    ]
  })

beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), 'web-workbench-')))
  adapter = new ManualAdapter()
  cursors.length = 0
  streams.clear()
  resumeError = undefined
  service = await openService()

  page = await browser.newPage()
  await page.goto(origin)
  await page.getByLabel('访问令牌').fill(service.token)
  await page.getByRole('button', { name: '进入工作台' }).click()
  await browserExpect(page).toHaveURL(/workspace/)
})

afterEach(async () => {
  await page.close()
  await service.close()
  await rm(directory, { force: true, recursive: true })
})

afterAll(async () => {
  await browser?.close()
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

describe('project navigation through the real service', () => {
  test('creates directory bindings, switches projects and restores a direct route', async () => {
    await browserExpect(page.getByText('创建第一个项目')).toBeVisible()
    await page.getByLabel('项目名称').fill('Alpha')
    await page.getByLabel('服务端工作目录').fill(`${directory}/missing`)
    await page.getByRole('button', { exact: true, name: '创建项目' }).click()
    await browserExpect(page.getByRole('alert').filter({ hasText: '创建失败' })).toBeVisible()
    await page.getByLabel('服务端工作目录').fill(directory)
    await page.getByRole('button', { exact: true, name: '创建项目' }).click()
    await browserExpect(page.getByRole('heading', { exact: true, name: 'Alpha' })).toBeVisible()
    const alphaUrl = page.url()
    await page.getByRole('button', { exact: true, name: '新建项目' }).click()
    await page.getByLabel('项目名称').fill('Beta')
    await page.getByLabel('服务端工作目录').fill(directory)
    await page.getByRole('button', { exact: true, name: '创建项目' }).click()
    await browserExpect(page.getByRole('heading', { exact: true, name: 'Beta' })).toBeVisible()
    await page.goto(alphaUrl)
    await browserExpect(page.getByRole('heading', { exact: true, name: 'Alpha' })).toBeVisible()
    await browserExpect(page.getByText(directory, { exact: true })).toBeVisible()
    await page.reload()
    await browserExpect(page.getByRole('heading', { exact: true, name: 'Alpha' })).toBeVisible()
    await page.goto(`${origin}/workspace?project=missing`)
    await browserExpect(page.getByText('项目不存在或无法加载')).toBeVisible()
    await page.goto(alphaUrl)
    await page.setViewportSize({ height: 844, width: 390 })
    await page.getByRole('button', { name: '展开导航' }).click()
    await page.getByRole('link', { exact: true, name: 'Beta' }).click()
    await browserExpect(page.getByRole('heading', { exact: true, name: 'Beta' })).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.setViewportSize({ height: 900, width: 1280 })
  }, 30000)
})

const createProject = async (name: string) => {
  await page.getByRole('button', { exact: true, name: '新建项目' }).click()
  await page.getByLabel('项目名称').fill(name)
  await page.getByLabel('服务端工作目录').fill(directory)
  await page.getByRole('button', { exact: true, name: '创建项目' }).click()
  await browserExpect(page.getByRole('heading', { exact: true, name })).toBeVisible()
}
const createSession = async (title: string) => {
  await page.getByRole('button', { exact: true, name: '新建会话' }).click()
  await page.getByLabel('会话标题').fill(title)
  await browserExpect(page.getByLabel('模型')).toHaveValue('deployment-model')
  await page.getByLabel('模型').fill('test-model')
  await page.getByRole('button', { exact: true, name: '创建会话' }).click()
  await browserExpect(page.getByRole('heading', { exact: true, name: title })).toBeVisible()
}

test('recovers an uncertain submission once, replays text and tools, and isolates sessions', async () => {
  await createProject('Chat')
  await createSession('First')
  const firstUrl = page.url()
  const requestIds: string[] = []
  await page.route('**/sessions/*/runs', async (route) => {
    if (route.request().method() !== 'POST') {
      return route.continue()
    }
    requestIds.push(route.request().postDataJSON().requestId)
    const response = await route.fetch()
    if (requestIds.length === 1) {
      await route.abort()
    } else {
      await route.fulfill({ response })
    }
  })
  await page.getByLabel('消息').fill('hello durable chat')
  await page.getByRole('button', { exact: true, name: '发送' }).click()
  await browserExpect(page.getByText('发送结果不确定')).toBeVisible()
  await page.getByRole('button', { exact: true, name: '确认原请求' }).click()
  await expect.poll(() => adapter.executions.size).toBe(1)
  const runId = [...adapter.executions.keys()][0]!
  for (const event of [
    { messageId: 'm', role: 'assistant', type: 'TEXT_MESSAGE_START' },
    {
      delta: '**hello**\n\n```js\nconst x = 1\n```\n\n[unsafe](javascript:alert(1))',
      messageId: 'm',
      type: 'TEXT_MESSAGE_CONTENT'
    },
    { messageId: 'm', type: 'TEXT_MESSAGE_END' },
    { toolCallId: 't', toolCallName: 'read_file', type: 'TOOL_CALL_START' },
    { delta: '{"path":"test.txt"}', toolCallId: 't', type: 'TOOL_CALL_ARGS' },
    { toolCallId: 't', type: 'TOOL_CALL_END' },
    { content: 'tool output', messageId: 'tool', role: 'tool', toolCallId: 't', type: 'TOOL_CALL_RESULT' }
  ]) {
    await adapter.push(runId, { event: parseEvent(event), kind: 'event' })
  }
  await browserExpect(page.getByText('tool output', { exact: true })).toBeVisible()
  if (process.env.WEB_SCREENSHOTS) {
    await page.screenshot({ fullPage: true, path: join(process.env.WEB_SCREENSHOTS, 'chat.png') })
  }
  await createSession('Second')
  await browserExpect(page.getByText('tool output', { exact: true })).toHaveCount(0)
  await page.goto(firstUrl)
  await browserExpect(page.getByText('tool output', { exact: true })).toBeVisible()
  expect(adapter.cancelled).toHaveLength(0)
  adapter.finish(runId, { status: 'succeeded' })
  await browserExpect(page.getByText('已完成', { exact: true })).toBeVisible()
  await page.reload()
  await browserExpect(page.getByText('hello durable chat', { exact: true })).toBeVisible()
  await browserExpect(page.locator('strong').filter({ hasText: 'hello' })).toHaveCount(1)
  await browserExpect(page.getByRole('button', { name: '复制代码' })).toBeVisible()
  expect(await page.locator('a[href^="javascript:"]').count()).toBe(0)
  expect(requestIds).toHaveLength(2)
  expect(new Set(requestIds).size).toBe(1)
  expect(adapter.executions.size).toBe(1)
  expect((await page.request.delete(`${origin}/runs/${runId}/events`, { headers: { origin } })).status()).toBe(200)
  await browserExpect(page.getByText('此运行的事件历史已清除。')).toBeVisible()
  await browserExpect(page.getByText('tool output', { exact: true })).toHaveCount(0)
}, 30000)

test('restores mixed approvals and input, and waits for the actual cancellation outcome', async () => {
  await createProject('Interactions')
  await createSession('Approval session')
  const before = new Set(adapter.executions.keys())
  await page.getByLabel('消息').fill('needs permission')
  await page.getByRole('button', { exact: true, name: '发送' }).click()
  await expect.poll(() => [...adapter.executions.keys()].find((id) => !before.has(id))).toBeTruthy()
  const runId = [...adapter.executions.keys()].find((id) => !before.has(id))!
  await adapter.push(runId, {
    event: parseEvent({ messageId: 'ui', role: 'assistant', type: 'TEXT_MESSAGE_START' }),
    kind: 'event'
  })
  await adapter.push(runId, {
    event: parseEvent({
      delta: '```openui\nroot = Card("操作摘要", "等待决定")\n```',
      messageId: 'ui',
      type: 'TEXT_MESSAGE_CONTENT'
    }),
    kind: 'event'
  })
  await browserExpect(page.getByRole('heading', { name: '操作摘要' })).toBeVisible()
  await adapter.push(runId, {
    kind: 'approval-batch',
    request: {
      nativeRequestId: 'batch',
      requests: [
        {
          allowedDecisions: ['approve', 'deny'],
          detail: { command: '<script>bad()</script>' },
          kind: 'command',
          nativeRequestId: 'a'
        },
        { allowedDecisions: ['deny'], detail: { tool: 'write' }, kind: 'tool', nativeRequestId: 'b' }
      ]
    }
  })
  await page.reload()
  await browserExpect(page.getByText('等待审批', { exact: true })).toBeVisible()
  await browserExpect(page.getByText('<script>bad()</script>', { exact: false })).toBeVisible()
  await page.getByRole('button', { exact: true, name: '批准' }).click()
  await browserExpect(page.getByText('已决定：批准，等待批次收齐')).toBeVisible()
  expect(adapter.batches).toHaveLength(0)
  await page.getByRole('button', { exact: true, name: '拒绝' }).last().click()
  await expect.poll(() => adapter.batches.length).toBe(1)
  expect(adapter.batches[0]?.decisions.map((item) => item.decision)).toEqual(['approve', 'deny'])
  await adapter.push(runId, {
    kind: 'input',
    request: {
      nativeRequestId: 'question',
      questions: [
        { header: '目标', id: 'q', options: [{ description: '运行测试', label: '测试' }], question: '请输入目标' }
      ]
    }
  })
  await page.reload()
  await page.setViewportSize({ height: 844, width: 390 })
  await page.getByLabel('请输入目标').fill('补充答案')
  if (process.env.WEB_SCREENSHOTS) {
    await page.screenshot({ fullPage: true, path: join(process.env.WEB_SCREENSHOTS, 'input-mobile.png') })
  }
  await page.getByRole('button', { name: '提交补充输入' }).click()
  await expect.poll(() => adapter.answers.length).toBe(1)
  expect(adapter.answers[0]).toMatchObject({ answers: { q: ['补充答案'] }, runId })
  adapter.finishOnCancel = false
  await page.getByRole('button', { exact: true, name: '取消运行' }).click()
  await expect.poll(() => adapter.cancelled.includes(runId)).toBe(true)
  await browserExpect(page.getByText('正在取消，等待执行结束', { exact: true })).toBeVisible()
  await browserExpect(page.getByRole('button', { exact: true, name: '发送' })).toBeDisabled()
  adapter.finish(runId, { status: 'cancelled' })
  await browserExpect(page.getByText('已取消', { exact: true })).toBeVisible()
  expect([...adapter.executions.keys()].filter((id) => !before.has(id))).toHaveLength(1)
  adapter.finishOnCancel = true
}, 30000)

test('reconnects from the durable event cursor without repeating text or execution', async () => {
  await createProject('Reconnect')
  await createSession('Stream')
  await page.getByLabel('消息').fill('stream')
  await page.getByRole('button', { exact: true, name: '发送' }).click()
  await expect.poll(() => adapter.executions.size).toBe(1)
  const runId = [...adapter.executions.keys()][0]!
  for (const event of [
    { messageId: 'm', role: 'assistant', type: 'TEXT_MESSAGE_START' },
    { delta: 'before ', messageId: 'm', type: 'TEXT_MESSAGE_CONTENT' }
  ]) {
    await adapter.push(runId, { event: parseEvent(event), kind: 'event' })
  }
  await browserExpect(page.getByText('before', { exact: true })).toBeVisible()
  streams.get(runId)?.destroy()
  await adapter.push(runId, {
    event: parseEvent({ delta: 'after', messageId: 'm', type: 'TEXT_MESSAGE_CONTENT' }),
    kind: 'event'
  })
  await browserExpect(page.getByText('before after', { exact: true })).toBeVisible()
  expect(cursors.some((cursor) => cursor > 0)).toBe(true)
  await browserExpect(page.getByText('before after', { exact: true })).toHaveCount(1)
  expect(adapter.executions.size).toBe(1)
  adapter.finish(runId, { status: 'succeeded' })
  await browserExpect(page.getByText('已完成', { exact: true })).toBeVisible()
}, 30000)

test('does not resend an uncertain approval after refresh and rejects a late input answer', async () => {
  await createProject('Uncertain approval')
  await createSession('Control')
  await page.getByLabel('消息').fill('control')
  await page.getByRole('button', { exact: true, name: '发送' }).click()
  await expect.poll(() => adapter.executions.size).toBe(1)
  const runId = [...adapter.executions.keys()][0]!
  adapter.confirmApprovals = false
  await adapter.push(runId, {
    kind: 'approval',
    request: {
      allowedDecisions: ['approve', 'deny'],
      detail: { command: 'safe-test' },
      kind: 'command',
      nativeRequestId: 'permission'
    }
  })
  let sends = 0
  await page.route('**/runs/*/approvals/*', async (route) => {
    sends++
    await route.fetch()
    await route.abort()
  })
  await page.getByRole('button', { exact: true, name: '批准' }).click()
  await browserExpect(page.getByText('审批未确认、已过期或已处理。已保留操作信息，不重发授权。')).toBeVisible()
  await page.reload()
  await browserExpect(page.getByText('已决定：批准，等待执行确认')).toBeVisible()
  await browserExpect(page.getByRole('button', { exact: true, name: '批准' })).toHaveCount(0)
  expect(sends).toBe(1)
  expect(adapter.decisions).toHaveLength(1)
  await adapter.push(runId, { kind: 'approval-resolved', nativeRequestId: 'permission' })
  await adapter.push(runId, {
    kind: 'input',
    request: { nativeRequestId: 'late', questions: [{ header: '晚到', id: 'q', question: '晚到回答' }] }
  })
  await page.getByLabel('晚到回答').fill('answer')
  await page.route('**/runs/*/inputs/*', async (route) => {
    adapter.finish(runId, { status: 'cancelled' })
    await expect
      .poll(async () => {
        const response = await page.request.get(`${origin}/runs/${runId}`)
        return (await response.json()).status
      })
      .toBe('cancelled')
    const response = await route.fetch()
    expect(response.status()).toBe(409)
    await route.fulfill({ response })
  })
  await page.getByRole('button', { name: '提交补充输入' }).click()
  await browserExpect(page.getByText('已取消', { exact: true })).toBeVisible()
  await browserExpect(page.getByText('交互已过期或已处理，提交被拒绝。')).toBeVisible()
  expect(adapter.answers).toHaveLength(0)
  expect(adapter.executions.size).toBe(1)
}, 30000)

test('shows loading and transport failures, isolates project sessions, and restores an archived session', async () => {
  const gate = Promise.withResolvers<void>()
  await page.route(
    (url) => url.pathname === '/projects',
    async (route) => {
      await gate.promise
      await route.continue()
    }
  )
  await page.reload()
  await browserExpect(page.getByText('正在加载项目…')).toBeVisible()
  gate.resolve()
  await page.unrouteAll({ behavior: 'wait' })
  await createProject('Project A')
  await page.getByRole('button', { exact: true, name: '新建会话' }).click()
  await page.getByLabel('模型').fill(' ')
  await page.getByRole('button', { exact: true, name: '创建会话' }).click()
  await browserExpect(page.getByText('会话创建失败，请检查模型、目录、资源配置及服务连接。')).toBeVisible()
  expect(adapter.created).toHaveLength(0)
  await page.getByRole('button', { name: '返回会话' }).click()
  await createSession('Only A')
  const firstUrl = new URL(page.url())
  await page.getByRole('button', { exact: true, name: '归档会话' }).click()
  await browserExpect(page.getByRole('button', { exact: true, name: '恢复会话' })).toBeVisible()
  await browserExpect(page.getByRole('link', { exact: true, name: 'Only A' })).toHaveCount(0)
  await page.getByLabel('显示已归档').check()
  await browserExpect(page.getByRole('link', { exact: true, name: 'Only A' })).toBeVisible()
  await page.getByRole('button', { exact: true, name: '恢复会话' }).click()
  await page.getByLabel('显示已归档').uncheck()
  await browserExpect(page.getByRole('link', { exact: true, name: 'Only A' })).toBeVisible()
  await createProject('Project B')
  await browserExpect(page.getByRole('link', { exact: true, name: 'Only A' })).toHaveCount(0)
  const other = new URL(page.url())
  other.searchParams.set('session', firstUrl.searchParams.get('session') ?? '')
  await page.goto(other.href)
  await browserExpect(page.getByText('会话不存在、不属于当前项目或无法加载。')).toBeVisible()
  await browserExpect(page.getByLabel('消息')).toHaveCount(0)
  await page.route(
    (url) => url.pathname === '/projects',
    (route) => route.abort()
  )
  await page.reload()
  await browserExpect(page.getByText('项目列表加载失败')).toBeVisible()
  await page.unrouteAll()
  await page.getByRole('navigation', { exact: true, name: '项目' }).getByRole('button', { name: '重试' }).click()
  await browserExpect(page.getByRole('link', { exact: true, name: 'Project A' })).toBeVisible()
}, 30000)

test('generates a card with presentation instructions and restores it from history', async () => {
  await createProject('Cards')
  await createSession('Card conversation')
  await page.getByLabel('消息').fill('用卡片总结本次发布')
  await page.getByRole('button', { exact: true, name: '发送' }).click()
  await expect.poll(() => adapter.executions.size).toBe(1)
  const runId = [...adapter.executions.keys()][0]!
  expect(adapter.executions.get(runId)?.text).toContain('Card(')
  expect(adapter.executions.get(runId)?.text).toContain('用卡片总结本次发布')
  await adapter.push(runId, {
    event: parseEvent({ messageId: 'card', role: 'assistant', type: 'TEXT_MESSAGE_START' }),
    kind: 'event'
  })
  for (const delta of ['发布摘要\n\n```op', 'enui\nroot = Card("发布进度", "', '已完成核心能力")\n']) {
    await adapter.push(runId, {
      event: parseEvent({ delta, messageId: 'card', type: 'TEXT_MESSAGE_CONTENT' }),
      kind: 'event'
    })
  }
  await browserExpect(page.getByRole('heading', { name: '发布进度' })).toBeVisible()
  await browserExpect(page.getByText('已完成核心能力', { exact: true })).toBeVisible()
  await adapter.push(runId, {
    event: parseEvent({ delta: '```\n\n**下一步**', messageId: 'card', type: 'TEXT_MESSAGE_CONTENT' }),
    kind: 'event'
  })
  adapter.finish(runId, { status: 'succeeded' })
  await browserExpect(page.getByText('已完成', { exact: true })).toBeVisible()
  await page.reload()
  await browserExpect(page.getByRole('heading', { name: '发布进度' })).toBeVisible()
  await browserExpect(page.locator('strong').filter({ hasText: '下一步' })).toBeVisible()
  await browserExpect(page.getByText('用卡片总结本次发布', { exact: true })).toBeVisible()
  expect(adapter.executions.size).toBe(1)
}, 30000)

test('streams mixed cards and accessible tables across chunks and restores their order', async () => {
  await createProject('Tables')
  await createSession('Comparison')
  await page.getByLabel('消息').fill('用表格比较方案，再给出卡片结论')
  await page.getByRole('button', { exact: true, name: '发送' }).click()
  await expect.poll(() => adapter.executions.size).toBe(1)
  const runId = [...adapter.executions.keys()][0]!
  expect(adapter.executions.get(runId)?.text).toContain('Table(')
  await adapter.push(runId, {
    event: parseEvent({ messageId: 'mixed', role: 'assistant', type: 'TEXT_MESSAGE_START' }),
    kind: 'event'
  })
  for (const delta of [
    '方案比较\n\n```openui\nroot = Table("候选方案", ["名称", "状态"], [["方案 A", ',
    '"可用"], ["方案 B", "待验证"]])\n',
    '```\n\n```openui\nroot = Card("建议", "先采用方案 A")\n```\n\n',
    '```openui\nroot = Table("后续计划", ["Requirements", "Implementation", "Verification", "Documentation", "Deployment"], [])\n```'
  ]) {
    await adapter.push(runId, {
      event: parseEvent({ delta, messageId: 'mixed', type: 'TEXT_MESSAGE_CONTENT' }),
      kind: 'event'
    })
  }
  const table = page.getByRole('table', { name: '候选方案' })
  await browserExpect(table.getByRole('columnheader', { name: '状态' })).toBeVisible()
  await browserExpect(table.getByRole('cell', { name: '待验证' })).toBeVisible()
  await browserExpect(page.getByRole('heading', { name: '建议' })).toBeVisible()
  await browserExpect(page.getByRole('table', { name: '后续计划' })).toBeVisible()
  await page.setViewportSize({ height: 844, width: 390 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  const scroll = page.getByRole('region', { name: '后续计划' })
  expect(await scroll.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true)
  await scroll.focus()
  await page.keyboard.press('ArrowRight')
  await expect.poll(() => scroll.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0)
  if (process.env.WEB_SCREENSHOTS) {
    await page.screenshot({ fullPage: true, path: join(process.env.WEB_SCREENSHOTS, 'openui-mobile.png') })
  }
  adapter.finish(runId, { status: 'succeeded' })
  await browserExpect(page.getByText('已完成', { exact: true })).toBeVisible()
  await page.reload()
  await browserExpect(table.getByRole('cell', { exact: true, name: '方案 A' })).toBeVisible()
  expect(await page.locator('caption, h3').allTextContents()).toEqual(['候选方案', '建议', '后续计划'])
  expect(adapter.executions.size).toBe(1)
}, 30000)

test.each([
  ['trailing prose', 'root = Card("摘要", "内容")\n不应静默丢失的文字'],
  ['duplicate root', 'root = Card("摘要", "第一张")\nroot = Card("摘要", "第二张")'],
  ['unknown component', 'root = Unknown("不可用")'],
  ['invalid property', 'root = Card(123, "内容")'],
  ['unresolved reference', 'root = Card("引用", missing)'],
  ['malformed syntax', 'root = Card(title: "错误", body: "内容")'],
  ['incomplete expression', 'root = Card("未完成", "内容'],
  ['discarded content', 'root = Card("摘要", "部分内容")\nextra = Card("丢失", "不得隐藏")'],
  ['uneven table', 'root = Table("错误表格", ["甲", "乙"], [["缺一格"]])'],
  ['query', 'data = Query("fetch", {url: "https://example.com"})\nroot = Card("查询", "禁止执行")'],
  ['mutation', 'data = Mutation("remove", {})\nroot = Card("操作", "禁止执行")'],
  ['state', '$count = 1\nroot = Card("状态", "禁止执行")']
])(
  'keeps the source of %s readable without losing adjacent messages',
  async (_, source) => {
    await createProject('Fallback')
    await createSession('Invalid content')
    await page.getByLabel('消息').fill('检查异常内容')
    await page.getByRole('button', { exact: true, name: '发送' }).click()
    await expect.poll(() => adapter.executions.size).toBe(1)
    const runId = [...adapter.executions.keys()][0]!
    await adapter.push(runId, {
      event: parseEvent({ messageId: 'bad', role: 'assistant', type: 'TEXT_MESSAGE_START' }),
      kind: 'event'
    })
    await adapter.push(runId, {
      event: parseEvent({
        delta: `之前\n\n\`\`\`openui\n${source}\n\`\`\`\n\n\`\`\`openui\nroot = Card("仍可用", "后续内容")\n\`\`\``,
        messageId: 'bad',
        type: 'TEXT_MESSAGE_CONTENT'
      }),
      kind: 'event'
    })
    adapter.finish(runId, { status: 'succeeded' })
    await browserExpect(page.getByText('已完成', { exact: true })).toBeVisible()
    await browserExpect(page.getByText('富内容无法完整显示，已保留原文。')).toBeVisible()
    await browserExpect(page.locator('pre').filter({ hasText: source })).toBeVisible()
    await browserExpect(page.getByRole('heading', { name: '仍可用' })).toBeVisible()
    await browserExpect(page.getByLabel('消息')).toBeEnabled()
    expect(adapter.executions.size).toBe(1)
  },
  30000
)

test.each(['succeeded', 'failed', 'cancelled'] as const)(
  'preserves an unclosed UI block after a %s run',
  async (status) => {
    await createProject('Interrupted UI')
    await createSession('Unclosed fence')
    await page.getByLabel('消息').fill('生成摘要')
    await page.getByRole('button', { exact: true, name: '发送' }).click()
    await expect.poll(() => adapter.executions.size).toBe(1)
    const runId = [...adapter.executions.keys()][0]!
    await adapter.push(runId, {
      event: parseEvent({ messageId: 'partial', role: 'assistant', type: 'TEXT_MESSAGE_START' }),
      kind: 'event'
    })
    const source = 'root = Card("临时摘要", "已收到的内容")'
    await adapter.push(runId, {
      event: parseEvent({ delta: `\`\`\`openui\n${source}\n`, messageId: 'partial', type: 'TEXT_MESSAGE_CONTENT' }),
      kind: 'event'
    })
    await browserExpect(page.getByRole('heading', { name: '临时摘要' })).toBeVisible()
    if (status === 'cancelled') {
      await page.getByRole('button', { exact: true, name: '取消运行' }).click()
    } else {
      adapter.finish(runId, { status })
    }
    await browserExpect(page.getByText('富内容无法完整显示，已保留原文。')).toBeVisible()
    await browserExpect(page.locator('pre').filter({ hasText: source })).toBeVisible()
    await page.reload()
    await browserExpect(page.locator('pre').filter({ hasText: source })).toBeVisible()
    expect(adapter.executions.size).toBe(1)
  },
  30000
)

test('reconnects while a table is streaming without repeating its rows or the run', async () => {
  await createProject('Recover table')
  await createSession('Streaming table')
  await page.getByLabel('消息').fill('列出结果')
  await page.getByRole('button', { exact: true, name: '发送' }).click()
  await expect.poll(() => adapter.executions.size).toBe(1)
  const runId = [...adapter.executions.keys()][0]!
  await adapter.push(runId, {
    event: parseEvent({ messageId: 'table', role: 'assistant', type: 'TEXT_MESSAGE_START' }),
    kind: 'event'
  })
  await adapter.push(runId, {
    event: parseEvent({
      delta: '```openui\nroot = Table("恢复结果", ["名称"], [["第一行"]',
      messageId: 'table',
      type: 'TEXT_MESSAGE_CONTENT'
    }),
    kind: 'event'
  })
  await browserExpect(page.getByRole('cell', { name: '第一行' })).toBeVisible()
  streams.get(runId)?.destroy()
  for (const delta of [', ["第二', '行"]])\n```']) {
    await adapter.push(runId, {
      event: parseEvent({ delta, messageId: 'table', type: 'TEXT_MESSAGE_CONTENT' }),
      kind: 'event'
    })
  }
  await browserExpect(page.getByRole('cell', { name: '第二行' })).toBeVisible()
  expect(cursors.some((cursor) => cursor > 0)).toBe(true)
  adapter.finish(runId, { status: 'succeeded' })
  await browserExpect(page.getByText('已完成', { exact: true })).toBeVisible()
  await page.reload()
  await browserExpect(page.getByRole('cell', { name: '第一行' })).toHaveCount(1)
  await browserExpect(page.getByRole('cell', { name: '第二行' })).toHaveCount(1)
  expect(adapter.executions.size).toBe(1)
}, 30000)

test('renders untrusted strings as text and never treats user or tool content as UI', async () => {
  await createProject('Read-only UI')
  await createSession('Safe content')
  const source = '```openui\nroot = Card("用户内容", "不应渲染")\n```'
  await page.getByLabel('消息').fill(source)
  await page.getByRole('button', { exact: true, name: '发送' }).click()
  await expect.poll(() => adapter.executions.size).toBe(1)
  const runId = [...adapter.executions.keys()][0]!
  const requests: string[] = []
  page.on('request', (request) => {
    if (!request.url().startsWith(origin)) {
      requests.push(request.url())
    }
  })
  for (const event of [
    { messageId: 'user', role: 'user', type: 'TEXT_MESSAGE_START' },
    { delta: source, messageId: 'user', type: 'TEXT_MESSAGE_CONTENT' },
    { messageId: 'user', type: 'TEXT_MESSAGE_END' },
    { toolCallId: 'tool', toolCallName: 'result', type: 'TOOL_CALL_START' },
    { delta: '{}', toolCallId: 'tool', type: 'TOOL_CALL_ARGS' },
    { toolCallId: 'tool', type: 'TOOL_CALL_END' },
    { content: source, messageId: 'tool-message', role: 'tool', toolCallId: 'tool', type: 'TOOL_CALL_RESULT' },
    { messageId: 'safe', role: 'assistant', type: 'TEXT_MESSAGE_START' },
    {
      delta:
        '```openui\nroot = Card("安全展示", "<img src=https://example.com/track onerror=alert(1)><script>alert(1)</script>")\n```\n\n```js\nroot = Card("代码示例", "不渲染")\n```',
      messageId: 'safe',
      type: 'TEXT_MESSAGE_CONTENT'
    }
  ]) {
    await adapter.push(runId, { event: parseEvent(event), kind: 'event' })
  }
  adapter.finish(runId, { status: 'succeeded' })
  await browserExpect(page.getByText('已完成', { exact: true })).toBeVisible()
  await browserExpect(page.getByRole('heading', { name: '安全展示' })).toBeVisible()
  await browserExpect(
    page.getByText('<img src=https://example.com/track onerror=alert(1)><script>alert(1)</script>', { exact: true })
  ).toBeVisible()
  await browserExpect(page.getByRole('heading', { name: '用户内容' })).toHaveCount(0)
  await browserExpect(page.getByRole('heading', { name: '代码示例' })).toHaveCount(0)
  await browserExpect(page.locator('.markdown img, .markdown script')).toHaveCount(0)
  expect(requests).toEqual([])
  expect(adapter.executions.size).toBe(1)
}, 30000)

test('restores the selected active session after logout and an unauthenticated deep link', async () => {
  await createProject('Login history')
  await createSession('Keep selection')
  const selectedUrl = page.url()
  await page.getByLabel('消息').fill('keep running')
  await page.getByRole('button', { exact: true, name: '发送' }).click()
  await expect.poll(() => adapter.executions.size).toBe(1)
  const runId = [...adapter.executions.keys()][0]!
  await browserExpect(page.getByRole('button', { name: '归档会话' })).toBeDisabled()

  for (const deepLink of [false, true]) {
    await page.getByRole('button', { name: '退出登录' }).click()
    await browserExpect(page.getByLabel('访问令牌')).toBeVisible()
    await browserExpect(page.getByText('keep running', { exact: true })).toHaveCount(0)
    if (deepLink) {
      await page.goto(selectedUrl)
    }
    await page.getByLabel('访问令牌').fill(service.token)
    await page.getByRole('button', { name: '进入工作台' }).click()
    await browserExpect(page).toHaveURL(selectedUrl)
    await browserExpect(page.getByText('keep running', { exact: true })).toBeVisible()
    await browserExpect(page.getByRole('button', { name: '归档会话' })).toBeDisabled()
  }
  await adapter.push(runId, {
    event: parseEvent({ messageId: 'resume', role: 'assistant', type: 'TEXT_MESSAGE_START' }),
    kind: 'event'
  })
  await adapter.push(runId, {
    event: parseEvent({ delta: 'still subscribed', messageId: 'resume', type: 'TEXT_MESSAGE_CONTENT' }),
    kind: 'event'
  })
  await browserExpect(page.getByText('still subscribed', { exact: true })).toBeVisible()
  expect(adapter.executions.size).toBe(1)
  expect(adapter.cancelled).toHaveLength(0)
  adapter.finish(runId, { status: 'succeeded' })
}, 30000)

test('distinguishes an empty history from a failed history read', async () => {
  await createProject('Empty history')
  await createSession('No runs')
  await browserExpect(page.getByText('暂无消息，发送第一条消息开始会话。')).toBeVisible()
  await page.route('**/sessions/*/runs*', (route) => route.abort())
  await page.reload()
  await browserExpect(page.getByText('历史加载失败')).toBeVisible()
  await browserExpect(page.getByText('暂无消息，发送第一条消息开始会话。')).toHaveCount(0)
  await page.unrouteAll()
  await page.getByRole('alert').filter({ hasText: '历史加载失败' }).getByRole('button', { name: '重试' }).click()
  await browserExpect(page.getByText('暂无消息，发送第一条消息开始会话。')).toBeVisible()
}, 30000)

test('pages durable sessions and runs and preserves history through archive and recovery', async () => {
  await createProject('Paged history')
  await createSession('Oldest session')
  const selectedUrl = page.url()
  const search = new URL(selectedUrl).searchParams
  const sessionId = search.get('session')!
  for (let index = 0; index < 50; index++) {
    const response = await page.request.post(`${origin}/sessions`, {
      data: {
        cwd: directory,
        model: 'test-model',
        projectId: search.get('project'),
        runtime: 'codex',
        title: `Session ${index}`
      },
      headers: { origin }
    })
    expect(response.status()).toBe(200)
  }
  for (let index = 0; index < 51; index++) {
    const response = await page.request.post(`${origin}/sessions/${sessionId}/runs`, {
      data: { text: `History message ${index}` },
      headers: { origin }
    })
    expect(response.status()).toBe(200)
    const { runId } = await response.json()
    await adapter.waitStarted(runId)
    adapter.finish(runId, { status: 'succeeded' })
    await expect
      .poll(async () => (await (await page.request.get(`${origin}/runs/${runId}`)).json()).status)
      .toBe('succeeded')
  }
  await page.reload()
  await browserExpect(page.getByRole('link', { exact: true, name: 'Oldest session' })).toHaveCount(0)
  await page.getByRole('button', { name: '更多会话' }).click()
  await browserExpect(page.getByRole('link', { exact: true, name: 'Oldest session' })).toBeVisible()
  await browserExpect(page.getByText('History message 0', { exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: '更早的消息' }).click()
  await browserExpect(page.getByText('History message 0', { exact: true })).toBeVisible()
  await browserExpect(page.locator('article')).toHaveCount(51)
  expect(await page.locator('article > p:first-child').allTextContents()).toEqual(
    Array.from({ length: 51 }, (_, index) => `History message ${index}`)
  )
  const before = await (await page.request.get(`${origin}/sessions/${sessionId}`)).json()
  await page.getByRole('button', { exact: true, name: '归档会话' }).click()
  await browserExpect(page.getByRole('button', { name: '恢复会话' })).toBeVisible()
  await page.reload()
  await browserExpect(page.getByText('History message 50', { exact: true })).toBeVisible()
  await browserExpect(page.getByLabel('消息')).toBeDisabled()
  await page.setViewportSize({ height: 844, width: 390 })
  await page.getByRole('button', { name: '展开导航' }).focus()
  await page.keyboard.press('Enter')
  await page.getByLabel('显示已归档').focus()
  await page.keyboard.press('Space')
  await page.getByRole('link', { exact: true, name: 'Oldest session' }).focus()
  await page.keyboard.press('Enter')
  await browserExpect(page.getByRole('button', { name: '展开导航' })).toBeVisible()
  await page.getByRole('button', { name: '恢复会话' }).focus()
  await page.keyboard.press('Enter')
  await browserExpect(page.getByRole('button', { name: '归档会话' })).toBeVisible()
  const after = await (await page.request.get(`${origin}/sessions/${sessionId}`)).json()
  expect(after.nativeSessionId).toBe(before.nativeSessionId)
  expect(adapter.executions.size).toBe(51)
  expect(adapter.created).toHaveLength(51)
}, 60000)

test('opens persisted interrupted history in a new service without replaying native work', async () => {
  await createProject('Restart history')
  await createSession('Interrupted session')
  const selectedUrl = page.url()
  const sessionId = new URL(selectedUrl).searchParams.get('session')!
  await page.goto(`${origin}/login`)
  await service.close()
  // Seed the durable state left by an interrupted host, as in the runtime recovery suite.
  const store = await SessionStore.open(directory)
  await store.beginRun(sessionId, 'interrupted-run', { requestId: 'original-request', text: 'persisted request' })
  await store.appendEvent(
    'interrupted-run',
    parseEvent({ messageId: 'saved', role: 'assistant', type: 'TEXT_MESSAGE_START' })
  )
  await store.appendEvent(
    'interrupted-run',
    parseEvent({ delta: 'persisted answer', messageId: 'saved', type: 'TEXT_MESSAGE_CONTENT' })
  )
  await store.close()
  adapter = new ManualAdapter()
  service = await openService()

  await page.goto(selectedUrl)
  await page.getByLabel('访问令牌').fill(service.token)
  await page.getByRole('button', { name: '进入工作台' }).click()
  await browserExpect(page).toHaveURL(selectedUrl)
  await browserExpect(page.getByText('执行已中断', { exact: true })).toBeVisible()
  await browserExpect(page.getByText('persisted request', { exact: true })).toBeVisible()
  await browserExpect(page.getByText('persisted answer', { exact: true })).toBeVisible()
  await page.reload()
  await browserExpect(page.getByText('执行已中断', { exact: true })).toHaveCount(1)
  expect(adapter.created).toHaveLength(0)
  expect(adapter.resumed).toHaveLength(0)
  expect(adapter.executions.size).toBe(0)
}, 30000)

test.each([
  ['RPC_ERROR', 'Native thread history not found'],
  ['PROTOCOL_ERROR', 'Resumed thread identity does not match']
])(
  'reports %s when the native session cannot resume without replacing its identity',
  async (code, message) => {
    await createProject('Native history')
    await createSession('Original session')
    const sessionId = new URL(page.url()).searchParams.get('session')!
    const before = await (await page.request.get(`${origin}/sessions/${sessionId}`)).json()
    resumeError = new RuntimeError(code, message)
    await page.getByLabel('消息').fill('resume the original')
    await page.getByRole('button', { exact: true, name: '发送' }).click()
    await browserExpect(page.getByText('执行失败', { exact: true })).toBeVisible()
    await browserExpect(page.getByRole('alert').filter({ hasText: code })).toBeVisible()
    await page.reload()
    await browserExpect(page.getByRole('alert').filter({ hasText: code })).toBeVisible()
    const after = await (await page.request.get(`${origin}/sessions/${sessionId}`)).json()
    expect(after.nativeSessionId).toBe(before.nativeSessionId)
    expect(adapter.created).toHaveLength(1)
    expect(adapter.executions.size).toBe(0)
  },
  30000
)
