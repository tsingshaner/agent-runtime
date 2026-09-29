// biome-ignore-all lint/style/useNamingConvention: Process environment variables.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { chromium, expect } from '@playwright/test'

import { launchNitro } from '../server/test/nitro.fixture.ts'

if (process.env.RUN_REAL_CODEX !== '1' || !process.env.CODEX_MODEL) {
  process.stdout.write('UNVERIFIED: set RUN_REAL_CODEX=1 and CODEX_MODEL to run the real browser/Codex smoke.\n')
} else {
  const directory = await mkdtemp(join(tmpdir(), 'web-codex-smoke-'))
  const server = await launchNitro(directory, { CODEX_MODEL: process.env.CODEX_MODEL })
  try {
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL, headless: true })
    try {
      const page = await browser.newPage()
      await page.goto(server.url)
      await page.getByLabel('访问令牌').fill(server.token)
      await page.getByRole('button', { name: '进入工作台' }).click()
      await page.getByLabel('项目名称').fill('Browser smoke')
      await page.getByLabel('服务端工作目录').fill(directory)
      await page.getByRole('button', { exact: true, name: '创建项目' }).click()
      await page.getByRole('button', { exact: true, name: '新建会话' }).click()
      await page.getByLabel('会话标题').fill('Real Codex smoke')
      await expect(page.getByLabel('模型')).toHaveValue(process.env.CODEX_MODEL)
      await page.getByRole('button', { exact: true, name: '创建会话' }).click()
      await page.getByLabel('消息').fill('Reply exactly WEB_SMOKE_OK. Do not use tools.')
      await page.getByRole('button', { exact: true, name: '发送' }).click()
      await expect(page.getByText('已完成', { exact: true })).toBeVisible({ timeout: 120000 })
      await expect(page.getByText('WEB_SMOKE_OK', { exact: true })).toBeVisible()
      await page.reload()
      await expect(page.getByText('WEB_SMOKE_OK', { exact: true })).toBeVisible()
      process.stdout.write(
        'PASS: real Codex text and browser history recovery. UNVERIFIED: real tools, approvals and resources.\n'
      )
    } finally {
      await browser.close()
    }
  } finally {
    await server.close()
    await rm(directory, { force: true, recursive: true })
  }
}
