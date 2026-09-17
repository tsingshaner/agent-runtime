import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { describe, expect, test } from 'vitest'

const exec = promisify(execFile)
async function run(mode: string, dir: string) {
  const { stdout } = await exec(process.execPath, [join(import.meta.dirname, 'probe.ts'), mode, dir], {
    timeout: 20000
  })
  return JSON.parse(stdout)
}
async function temporary(check: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'deepagents-probe-'))
  try {
    await check(dir)
  } finally {
    await rm(dir, { force: true, recursive: true })
  }
}

describe('Deep Agents persistent approval probe', () => {
  test('reports the native mixed-batch limitation without claiming approved execution', async () => {
    await temporary(async (dir) => {
      const result = await run('batch', dir)
      expect(result.actions).toEqual(['approved', 'rejected'])
      expect(result.status).toBe('mixed_batch_unsupported')
      expect(result.effects).toEqual([])
      expect(result.pending).toBe(0)
      expect(result.rejectionObserved).toBe(true)
    })
  }, 30000)
  test('reopens a real checkpoint in a new process and refuses stale work', async () => {
    await temporary(async (dir) => {
      const first = await run('pause', dir)
      const reopened = await run('inspect', dir)
      expect(first.interrupts).toHaveLength(1)
      expect(reopened.interrupts).toEqual(first.interrupts)
      expect(reopened.pid).not.toBe(first.pid)
      expect(await run('new', dir)).toMatchObject({ effects: [], status: 'unsafe_resume' })
    })
  }, 30000)
  test('cancels a running tool before its side effect and refuses its checkpoint', async () => {
    await temporary(async (dir) => {
      expect(await run('cancel', dir)).toMatchObject({ effects: [], status: 'cancelled', toolStopped: true })
      expect(await run('new', dir)).toMatchObject({ effects: [], status: 'unsafe_resume' })
    })
  }, 30000)
  test('allows a new run from a completed checkpoint without replaying old effects', async () => {
    await temporary(async (dir) => {
      await run('approve', dir)
      const result = await run('new', dir)
      expect(result.status).toBe('completed')
      expect(result.effects.toSorted()).toEqual(['approved', 'rejected'])
      expect((await readFile(join(dir, 'effects.jsonl'), 'utf8')).trim().split('\n')).toHaveLength(2)
    })
  }, 30000)
})
