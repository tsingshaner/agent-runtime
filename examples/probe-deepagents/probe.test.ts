import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { describe, expect, test } from 'vitest'

const exec = promisify(execFile)
const run = async (mode: string, dir: string, decisions?: unknown) => {
  const { stdout } = await exec(
    process.execPath,
    [join(import.meta.dirname, 'probe.ts'), mode, dir, ...(decisions === undefined ? [] : [JSON.stringify(decisions)])],
    {
      timeout: 20000
    }
  )
  return JSON.parse(stdout)
}
const temporary = async (check: (dir: string) => Promise<void>) => {
  const dir = await mkdtemp(join(tmpdir(), 'deepagents-probe-'))
  try {
    await check(dir)
  } finally {
    await rm(dir, { force: true, recursive: true })
  }
}

describe('Deep Agents persistent approval probe', () => {
  test('retains evidence that built-in interruptOn still drops mixed-batch approvals', async () => {
    await temporary(async (dir) => {
      expect(await run('native', dir)).toMatchObject({
        effects: [],
        pending: 0,
        rejectionObserved: true,
        status: 'mixed_batch_unsupported'
      })
    })
  }, 30000)
  test('executes only the approved action from one mixed approval batch', async () => {
    await temporary(async (dir) => {
      const result = await run('batch', dir)
      expect(result.actions).toEqual(['approved', 'rejected'])
      expect(result.status).toBe('mixed_batch_supported')
      expect(result.effects).toEqual(['approved'])
      expect(result.pending).toBe(0)
      expect(result.rejectionObserved).toBe(true)
    })
  }, 30000)
  test('persists a mixed decision batch and resumes it after process restart', async () => {
    await temporary(async (dir) => {
      const paused = await run('pause', dir)
      const resumed = await run('resume', dir)
      expect(resumed.pid).not.toBe(paused.pid)
      expect(resumed.effects).toEqual(['approved'])
      expect(resumed.rejectionObserved).toBe(true)
      const saved = await run('inspect', dir)
      expect(saved.approvalSnapshots).toContainEqual([
        { decision: { type: 'approve' }, id: 'approved' },
        { decision: { message: 'Probe rejects this operation', type: 'reject' }, id: 'rejected' }
      ])
      expect(await run('new', dir)).toMatchObject({ effects: ['approved'], status: 'completed' })
      await expect(run('resume', dir)).rejects.toThrow()
      expect(await run('new', dir)).toMatchObject({ effects: ['approved'], status: 'completed' })
    })
  }, 30000)
  test('requires a new decision for reused call IDs in the next run', async () => {
    await temporary(async (dir) => {
      await run('approve', dir)
      const next = await run('pause', dir)
      expect(next.interrupts).toHaveLength(1)
      expect(next.effects.toSorted()).toEqual(['approved', 'rejected'])
      const result = await run('resume', dir, [{ type: 'reject' }, { type: 'reject' }])
      expect(result.effects.toSorted()).toEqual(['approved', 'rejected'])
    })
  }, 30000)
  test.each(
    [
      [],
      [{ type: 'approve' }],
      [{ type: 'approve' }, { type: 'approve' }, { type: 'approve' }],
      [{ type: 'approve' }, { type: 'unknown' }],
      [
        { id: 'approved', type: 'approve' },
        { id: 'approved', type: 'approve' }
      ]
    ].map((decisions) => ({ decisions }))
  )(
    'refuses malformed or incomplete decision batch $decisions before any effect',
    async ({ decisions }) => {
      await temporary(async (dir) => {
        await run('pause', dir)
        await expect(run('resume', dir, decisions)).rejects.toThrow('ZodError')
        expect(await run('new', dir)).toMatchObject({ effects: [], status: 'unsafe_resume' })
      })
    },
    30000
  )
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
