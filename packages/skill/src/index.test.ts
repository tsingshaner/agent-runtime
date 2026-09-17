import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test } from 'vitest'

import { Skills } from './index'

const sourceText = '---\nname: useful\ndescription: A useful skill\n---\nRead references/info.txt.'
test('imports and edits a managed copy, persists enabled bindings and preserves the source', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'skills-'))
  try {
    const source = join(directory, 'source')
    await mkdir(join(source, 'references'), { recursive: true })
    await writeFile(join(source, 'SKILL.md'), sourceText)
    await writeFile(join(source, 'references/info.txt'), 'Details')
    await writeFile(join(source, 'run.sh'), '#!/bin/sh\necho before')
    await chmod(join(source, 'run.sh'), 0o755)
    const skills = await Skills.open(join(directory, 'managed'))
    const skill = await skills.import(source)
    expect(await skills.read(skill.id, 'references/info.txt')).toBe('Details')
    await skills.edit(skill.id, 'run.sh', '#!/bin/sh\necho after')
    expect((await stat(join(skill.directory, 'run.sh'))).mode & 0o777).toBe(0o755)
    await skills.bind('project', skill.id, true)
    expect((await skills.list('project')).map(({ id }) => id)).toEqual([skill.id])
    await skills.edit(skill.id, 'SKILL.md', sourceText.replace('A useful skill', 'A revised skill'))
    expect((await skills.get(skill.id)).description).toBe('A revised skill')
    const reopened = await Skills.open(join(directory, 'managed'))
    expect((await reopened.list('project'))[0]?.enabled).toBe(true)
    await reopened.bind('project', skill.id, false)
    expect(await reopened.enabled('project')).toEqual([])
    expect(await reopened.enabled('other')).toEqual([])
    await expect(reopened.edit(skill.id, 'SKILL.md', 'invalid')).rejects.toMatchObject({ code: 'INVALID_SKILL' })
    await expect(reopened.read(skill.id, '../outside')).rejects.toMatchObject({ code: 'INVALID_PATH' })
    await symlink(directory, join(source, 'escape'))
    await expect(reopened.import(source)).rejects.toMatchObject({ code: 'INVALID_PATH' })
    await reopened.delete(skill.id)
    expect(await reopened.list()).toEqual([])
    expect(await readFile(join(source, 'SKILL.md'), 'utf8')).toBe(sourceText)
  } finally {
    await rm(directory, { force: true, recursive: true })
  }
})

test('keeps disabled missing skills out of preparation and preserves other owners bindings', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'skills-bindings-'))
  try {
    const source = join(directory, 'source')
    await mkdir(source)
    await writeFile(join(source, 'SKILL.md'), sourceText)
    const first = await Skills.open(join(directory, 'data'))
    const second = await Skills.open(join(directory, 'data'))
    const skill = await first.import(source)
    await first.bind('a', skill.id, true)
    await second.bind('b', skill.id, false)
    expect((await second.enabled('a')).map(({ id }) => id)).toEqual([skill.id])
    await rm(join(skill.directory, 'SKILL.md'))
    expect(await second.enabled('b')).toEqual([])
    await expect(first.enabled('a')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  } finally {
    await rm(directory, { force: true, recursive: true })
  }
})
