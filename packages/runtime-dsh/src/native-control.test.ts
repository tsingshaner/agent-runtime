// cspell:ignore unstub
import { randomUUID } from 'node:crypto'
import { access, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client'
import { describe, expect, test, vi } from 'vitest'

import { fixture } from '../test/fixture'

describe('DSH plugin wire boundary', () => {
  test('authenticates controls and withdraws approval when the execution channel disconnects', async () => {
    vi.stubEnv('DSH_TEST_KEY', 'fixture')
    const f = await fixture(() => ({ arguments: { command: 'printf forbidden > disconnected.txt' }, name: 'bash' }))
    const token = randomUUID()
    const addressFile = join(f.root, 'control.json')
    const patch = join(f.root, 'wire.patch.json')
    await writeFile(
      patch,
      JSON.stringify([
        {
          config: { apiKeyEnv: 'DSH_TEST_KEY', baseURL: f.runtime.options.baseURL, thinking: 'disabled' },
          id: 'llm-deepseek'
        },
        {
          insert: [
            { id: 'questions', name: '@deepseek-ai/dsh-user-questions' },
            { id: 'control', name: fileURLToPath(new URL('./control.ts', import.meta.url)) }
          ]
        }
      ])
    )
    const harness = new DeepSeekHarness({
      dshHome: join(f.root, 'wire-home'),
      env: {
        DSH_TEST_KEY: 'fixture',
        HOME: f.root,
        PATH: process.env.PATH,
        RUNTIME_DSH_ADDRESS: addressFile,
        RUNTIME_DSH_MODEL: 'deepseek-v4-flash',
        RUNTIME_DSH_SESSION: randomUUID(),
        RUNTIME_DSH_TOKEN: token
      },
      patches: [patch],
      processCwd: f.root,
      profile: 'sdk-minimal'
    })
    try {
      await harness.start()
      await expect.poll(async () => readFile(addressFile, 'utf8').catch(() => ''), { timeout: 5000 }).not.toBe('')
      const { port, pid } = JSON.parse(await readFile(addressFile, 'utf8')) as { port: number; pid: number }
      const call = (path: string, auth: string = token, signal?: AbortSignal) =>
        fetch(`http://127.0.0.1:${port}${path}`, {
          body: JSON.stringify({ text: 'attempt tool' }),
          headers: { authorization: `Bearer ${auth}` },
          method: 'POST',
          signal
        })
      expect((await call('/create', 'wrong')).status).toBe(401)
      expect((await call('/create')).status).toBe(200)
      const abort = new AbortController()
      const response = await call('/run', token, abort.signal)
      const reader = response.body?.getReader()
      if (!reader) {
        throw new Error('Missing stream')
      }
      let output = ''
      while (!output.includes('"kind":"approval"')) {
        const { value, done } = await reader.read()
        if (done) {
          throw new Error('Approval missing')
        }
        output += new TextDecoder().decode(value)
      }
      abort.abort()
      await reader.cancel().catch(() => {})
      await delay(200)
      expect((await call('/respond')).status).toBe(409)
      await expect(access(join(f.root, 'disconnected.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
      await harness.close()
      expect(() => process.kill(pid, 0)).toThrow()
    } finally {
      await harness.close()
      await f.close()
      vi.unstubAllEnvs()
    }
  }, 30000)
})
