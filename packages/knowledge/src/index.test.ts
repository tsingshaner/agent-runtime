import { mkdir, mkdtemp, readFile, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test } from 'vitest'

import { Knowledge } from './index'

test('persists bindings and manages complete Markdown documents through the public API', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'knowledge-'))
  try {
    const docs = join(directory, 'docs')
    await mkdir(docs)
    const knowledge = await Knowledge.open(join(directory, 'data'))
    await knowledge.bind('project', docs)
    await knowledge.create('project', 'guide.md', '# First\nUse blue widgets.')
    expect(await knowledge.list('project')).toEqual(['guide.md'])
    expect(await knowledge.search('project', 'BLUE')).toEqual([
      { excerpt: '# First\nUse blue widgets.', path: 'guide.md' }
    ])
    const reopened = await Knowledge.open(join(directory, 'data'))
    expect(await reopened.binding('project')).toBe(await realpath(docs))
    await reopened.edit('project', 'guide.md', '# Second\nUse green widgets.')
    expect(await reopened.read('project', 'guide.md')).toBe('# Second\nUse green widgets.')
    await expect(reopened.create('project', 'guide.md', 'overwrite')).rejects.toMatchObject({ code: 'ALREADY_EXISTS' })
    for (const path of ['../escape.md', '/tmp/escape.md', 'x/../../escape.md', 'guide.txt']) {
      await expect(reopened.create('project', path, 'bad')).rejects.toMatchObject({ code: 'INVALID_PATH' })
    }
    await symlink(directory, join(docs, 'outside'))
    await symlink(join(docs, 'guide.md'), join(docs, 'linked.md'))
    await expect(reopened.read('project', 'linked.md')).rejects.toMatchObject({ code: 'INVALID_PATH' })
    await expect(reopened.create('project', 'outside/escape.md', 'bad')).rejects.toMatchObject({ code: 'INVALID_PATH' })
    expect(await readFile(join(docs, 'guide.md'), 'utf8')).toBe('# Second\nUse green widgets.')
    await reopened.delete('project', 'guide.md')
    await expect(reopened.read('project', 'guide.md')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await reopened.unbind('project')
    await expect(reopened.list('project')).rejects.toMatchObject({ code: 'NOT_BOUND' })
  } finally {
    await rm(directory, { force: true, recursive: true })
  }
})

test('atomic replacement exposes whole versions and conflicting creates preserve the winner', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'knowledge-atomic-'))
  try {
    const docs = join(directory, 'docs')
    await mkdir(docs)
    const knowledge = await Knowledge.open(join(directory, 'data'))
    await knowledge.bind('p', docs)
    const creates = await Promise.allSettled([
      knowledge.create('p', 'a.md', 'a'.repeat(100000)),
      knowledge.create('p', 'a.md', 'lost')
    ])
    expect(creates.map(({ status }) => status)).toEqual(['fulfilled', 'rejected'])
    const old = 'a'.repeat(100000)
    const next = 'b'.repeat(100000)
    const [, ...reads] = await Promise.all([
      knowledge.edit('p', 'a.md', next),
      ...Array.from({ length: 10 }, () => knowledge.read('p', 'a.md'))
    ])
    for (const content of reads) {
      expect([old, next]).toContain(content)
    }
    expect(await knowledge.read('p', 'a.md')).toBe(next)
    await expect(knowledge.read('other', 'a.md')).rejects.toMatchObject({ code: 'NOT_BOUND' })
  } finally {
    await rm(directory, { force: true, recursive: true })
  }
})

test('independent instances preserve each other’s persisted project bindings', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'knowledge-bindings-'))
  try {
    const first = await Knowledge.open(join(directory, 'data'))
    const second = await Knowledge.open(join(directory, 'data'))
    await first.bind('first', directory)
    await second.bind('second', directory)
    expect(await second.binding('first')).toBe(await realpath(directory))
    expect(await first.binding('second')).toBe(await realpath(directory))
    await first.unbind('first')
    expect(await second.binding('second')).toBe(await realpath(directory))
  } finally {
    await rm(directory, { force: true, recursive: true })
  }
})
