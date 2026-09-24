// cspell:ignore unstub
import { execFileSync } from 'node:child_process'
import { access, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { fixture } from '../test/fixture'

describe('DSH native controls', () => {
  beforeEach(() => vi.stubEnv('DSH_TEST_KEY', 'fixture'))
  afterEach(() => vi.unstubAllEnvs())
  test('denies a tool before side effects and refuses a duplicate approval', async () => {
    const f = await fixture((_, i) =>
      i === 1 ? { arguments: { command: 'printf denied > denied.txt' }, name: 'bash' } : 'denied safely'
    )
    try {
      const session = await f.create()
      const { runId } = await f.manager.run(session.id, { text: 'deny tool' })
      await expect.poll(async () => (await f.manager.listPendingApprovals(runId)).length).toBe(1)
      const [approval] = await f.manager.listPendingApprovals(runId)
      if (!approval) {
        throw new Error('No approval')
      }
      await expect(access(join(f.root, 'denied.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
      await f.manager.respondApproval(runId, approval.id, 'deny')
      await Array.fromAsync(f.manager.subscribe(runId))
      await expect(access(join(f.root, 'denied.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(f.manager.respondApproval(runId, approval.id, 'approve')).rejects.toBeInstanceOf(Error)
      expect((await f.manager.getRun(runId)).status).toBe('succeeded')
    } finally {
      await f.close()
    }
  }, 30000)
  test('answers native questions within the same run', async () => {
    let received = false
    const f = await fixture((body, i) => {
      if (i === 1) {
        return { arguments: { questions: [{ id: 'color', question: 'Which color?' }] }, name: 'ask_user_question' }
      }
      received = JSON.stringify(body).includes('violet')
      return 'done'
    })
    try {
      const session = await f.create()
      const { runId } = await f.manager.run(session.id, { text: 'Ask for color' })
      await expect.poll(async () => (await f.manager.listPendingInputs(runId)).length, { timeout: 10000 }).toBe(1)
      const [input] = await f.manager.listPendingInputs(runId)
      if (!input) {
        throw new Error('No input')
      }
      expect((await f.manager.getRun(runId)).status).toBe('waiting_input')
      await f.manager.respondInput(runId, input.id, { color: ['violet'] })
      await Array.fromAsync(f.manager.subscribe(runId))
      expect((await f.manager.getRun(runId)).status).toBe('succeeded')
      expect(received).toBe(true)
    } finally {
      await f.close()
    }
  }, 30000)
  test('cancels waiting approval without affecting a second session', async () => {
    const f = await fixture((body) =>
      JSON.stringify(body).includes('wait-here')
        ? { arguments: { command: 'printf forbidden > forbidden.txt' }, name: 'bash' }
        : 'independent'
    )
    try {
      const first = await f.create()
      const second = await f.create()
      const waiting = await f.manager.run(first.id, { text: 'wait-here' })
      await expect
        .poll(async () => (await f.manager.listPendingApprovals(waiting.runId)).length, { timeout: 10000 })
        .toBe(1)
      const other = await f.manager.run(second.id, { text: 'finish normally' })
      await f.manager.cancel(waiting.runId)
      await Promise.all([
        Array.fromAsync(f.manager.subscribe(waiting.runId)),
        Array.fromAsync(f.manager.subscribe(other.runId))
      ])
      expect((await f.manager.getRun(waiting.runId)).status).toBe('cancelled')
      expect((await f.manager.getRun(other.runId)).status).toBe('succeeded')
      await expect(readFile(join(f.root, 'forbidden.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await f.close()
    }
  }, 30000)
  test.each(['SIGKILL', 'SIGSTOP'] as const)(
    'records interrupted after native %s and blocks unsafe resume',
    async (signal) => {
      const f = await fixture(() => ({ arguments: { command: 'printf unsafe > unsafe.txt' }, name: 'bash' }))
      try {
        const session = await f.create()
        const { runId } = await f.manager.run(session.id, { text: 'wait before effect' })
        await expect.poll(async () => (await f.manager.listPendingApprovals(runId)).length, { timeout: 10000 }).toBe(1)
        const patch = join(f.root, 'native', session.nativeSessionId, 'runtime.patch.json')
        const line = execFileSync('ps', ['-ax', '-o', 'pid=,ppid=,command='], { encoding: 'utf8' })
          .split('\n')
          .find((line) => line.includes(`--patch ${patch}`))
        if (!line) {
          throw new Error('Owned Harness not found')
        }
        const [pid, parent] = line.trim().split(/\s+/).map(Number)
        expect(parent).toBe(process.pid)
        if (!pid) {
          throw new Error('Missing owned PID')
        }
        process.kill(pid, signal)
        if (signal === 'SIGSTOP') {
          await f.manager.cancel(runId)
        }
        const events = await Array.fromAsync(f.manager.subscribe(runId))
        expect((await f.manager.getRun(runId)).status).toBe('interrupted')
        expect(events.filter(({ event }) => event.type === 'RUN_ERROR')).toHaveLength(1)
        await expect(f.manager.resumeSession(session.id)).rejects.toMatchObject({ code: 'UNSAFE_RESUME' })
        await expect(access(join(f.root, 'unsafe.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
        expect(() => process.kill(pid, 0)).toThrow()
      } finally {
        await f.close()
      }
    },
    40000
  )
})
