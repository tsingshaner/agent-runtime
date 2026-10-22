// biome-ignore-all lint/suspicious/noMisplacedAssertion: Standalone built HTTPS smoke.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { chromium, expect } from '@playwright/test'

import { launchHttpsNitro } from './test/https.fixture.ts'

const directory = await mkdtemp(join(tmpdir(), 'web-https-'))
try {
  const server = await launchHttpsNitro(directory, { CODEX_MODEL: 'deployment-model' })
  try {
    const browser = await chromium.launch({ headless: true })
    try {
      const page = await browser.newPage({ ignoreHTTPSErrors: true })
      expect((await page.request.get(`${server.url}/health`)).status()).toBe(401)
      expect((await page.request.get(`${server.url}/runs/unknown/events`)).status()).toBe(401)
      await page.goto(`${server.url}/workspace?view=memory`)
      await expect(page.getByLabel('访问令牌')).toBeVisible()
      await page.getByLabel('访问令牌').fill(server.token)
      await page.getByRole('button', { name: '进入工作台' }).click()
      await expect(page.getByLabel('项目名称')).toBeVisible()
      const cookies = await page.context().cookies()
      expect(cookies.some((cookie) => cookie.secure && cookie.httpOnly && cookie.sameSite === 'Strict')).toBe(true)
      expect(await page.evaluate(() => localStorage.length)).toBe(0)
      expect((await page.request.get(`${server.url}/health`)).status()).toBe(200)
      expect(
        (
          await page.request.post(`${server.url}/projects`, {
            data: { name: 'wrong origin' },
            headers: { origin: 'https://evil.example' }
          })
        ).status()
      ).toBe(403)
      await page.getByLabel('项目名称').fill('HTTPS acceptance')
      await page.getByLabel('服务端工作目录').fill(directory)
      await page.getByRole('button', { exact: true, name: '创建项目' }).click()
      await page.getByRole('button', { exact: true, name: '新建会话' }).click()
      await expect(page.getByLabel('模型')).toHaveValue('deployment-model')
      const skill = join(directory, 'skill')
      const knowledge = join(directory, 'notes')
      await mkdir(skill)
      await mkdir(knowledge)
      await writeFile(join(skill, 'SKILL.md'), '---\nname: https-helper\ndescription: HTTPS acceptance\n---\nRead only')
      await page.getByRole('link', { name: '技能管理' }).click()
      await page.getByLabel('服务端技能目录').fill(skill)
      await page.getByRole('button', { exact: true, name: '导入技能' }).click()
      await page.getByRole('button', { name: '绑定并启用' }).click()
      await expect(page.getByRole('article', { name: '项目技能 https-helper' })).toContainText('已启用')
      await page.getByRole('link', { name: 'MCP 管理' }).click()
      await expect(page.getByText('暂无 MCP 配置。')).toBeVisible()
      await page.getByRole('button', { name: '新建 MCP 配置' }).click()
      await page.getByLabel('服务名称', { exact: true }).fill('https-tools')
      await page.getByLabel('启动命令').fill(process.execPath)
      await page
        .getByLabel('参数（JSON 数组）')
        .fill(JSON.stringify([resolve(import.meta.dirname, '../../packages/mcp/test/server.fixture.ts')]))
      await page.getByRole('button', { exact: true, name: '创建 MCP 服务' }).click()
      const tools = page.getByRole('article', { exact: true, name: '共享 MCP https-tools' })
      await tools.getByRole('button', { name: '检测连接' }).click()
      await expect(tools.getByRole('status')).toHaveText('连接成功，发现 1 个工具。')
      await tools.getByRole('button', { name: '绑定并启用' }).click()
      await expect(page.getByRole('article', { exact: true, name: '项目 MCP https-tools' })).toContainText('已启用')
      await page.getByRole('link', { name: '知识管理' }).click()
      await page.getByLabel('服务端知识目录').fill(knowledge)
      await page.getByRole('button', { name: '绑定知识目录' }).click()
      await page.getByRole('button', { name: '新建文档' }).click()
      await page.getByLabel('文档相对路径（.md）').fill('acceptance.md')
      await page.getByLabel('Markdown 内容').fill('# HTTPS accepted')
      await page.getByRole('button', { name: '保存文档' }).click()
      await expect(page.getByRole('button', { exact: true, name: 'acceptance.md' })).toBeVisible()
      await page.getByRole('link', { name: '记忆管理' }).click()
      await expect(page.getByRole('alert')).toContainText('Memory 未配置')
      await page.reload()
      await expect(page.getByRole('heading', { name: '项目记忆' })).toBeVisible()
      await page.setViewportSize({ height: 844, width: 390 })
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      await page.getByRole('button', { name: '退出登录' }).focus()
      await page.keyboard.press('Enter')
      await expect(page.getByLabel('访问令牌')).toBeVisible()
      expect((await page.request.get(`${server.url}/health`)).status()).toBe(401)
      expect(
        (
          await page.request.get(`${server.url}/health`, { headers: { authorization: `Bearer ${server.token}` } })
        ).status()
      ).toBe(200)
      process.stdout.write(
        'PASS: built Nitro behind local HTTPS, Secure/HttpOnly/Strict Cookie, auth, origin rejection, deep links, default model, four resource pages, mobile keyboard logout and Bearer compatibility. Certificate is ephemeral/self-signed; public CA deployment is not verified.\n'
      )
    } finally {
      await browser.close()
    }
  } finally {
    await server.close()
  }
} finally {
  await rm(directory, { force: true, recursive: true })
}
