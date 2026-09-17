import { cp, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'
import { expect, test } from 'vitest'

import { ManualAdapter } from '../test/manual-adapter'
import { RuntimeManager } from './manager'

test('persists project identity across directories and manager restart', async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'runtime-project-')))
  const second = join(dir, 'second')
  await mkdir(second)
  const adapter = new ManualAdapter()
  let manager = await RuntimeManager.open({ dataDir: dir, runtimes: [adapter] })
  try {
    const project = await manager.createProject({ name: 'Example', workingDirectories: [dir, second] })
    const first = await manager.createSession({
      cwd: dir,
      model: 'explicit-model',
      projectId: project.id,
      runtime: 'manual'
    })
    const next = await manager.createSession({
      cwd: second,
      model: 'other-model',
      projectId: project.id,
      runtime: 'manual'
    })
    expect(first.model).toBe('explicit-model')
    expect(adapter.created[0]).toMatchObject({ model: 'explicit-model', projectId: project.id })
    expect(next.projectId).toBe(first.projectId)
    await manager.updateProject(project.id, { name: 'Renamed', workingDirectories: [second] })
    await manager.dispose()
    const resumed = new ManualAdapter()
    manager = await RuntimeManager.open({ dataDir: dir, runtimes: [resumed] })
    expect(await manager.getProject(project.id)).toMatchObject({
      id: project.id,
      name: 'Renamed',
      workingDirectories: [second]
    })
    expect((await manager.listProjects()).items).toHaveLength(1)
    await manager.resumeSession(first.id)
    expect(resumed.resumed[0]).toMatchObject({ model: 'explicit-model', projectId: project.id })
    expect((await manager.listSessions({ projectId: project.id })).items).toHaveLength(2)
    await expect(
      manager.createSession({ cwd: dir, model: 'x', projectId: 'missing', runtime: 'manual' })
    ).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' })
  } finally {
    await manager.dispose()
    await rm(dir, { force: true, recursive: true })
  }
})

test('validates projects and model configuration before native creation, with stable pagination', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'runtime-project-'))
  const adapter = new ManualAdapter()
  const manager = await RuntimeManager.open({ dataDir: dir, runtimes: [adapter] })
  try {
    const first = await manager.createProject({ id: 'first', name: 'First' })
    const second = await manager.createProject({ name: 'Second' })
    await expect(manager.createProject({ id: first.id, name: 'Duplicate' })).rejects.toMatchObject({
      code: 'PROJECT_EXISTS'
    })
    await expect(manager.createProject({ name: ' ', workingDirectories: [] })).rejects.toMatchObject({
      code: 'INVALID_INPUT'
    })
    await expect(manager.updateProject(first.id, { workingDirectories: [join(dir, 'missing')] })).rejects.toMatchObject(
      { code: 'INVALID_INPUT' }
    )
    for (const invalid of [{ model: '' }, { model: undefined }, { options: { model: 'hidden-model' } }]) {
      await expect(
        manager.createSession({
          cwd: dir,
          model: 'explicit',
          projectId: first.id,
          runtime: 'manual',
          ...invalid
        } as never)
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    }
    expect(adapter.created).toHaveLength(0)
    const page = await manager.listProjects({ limit: 1 })
    expect(page.items.map(({ id }) => id)).toEqual([second.id])
    expect(page.nextCursor).toBeTypeOf('string')
    expect((await manager.listProjects({ cursor: page.nextCursor ?? undefined, limit: 1 })).items).toEqual([first])
    expect(await manager.getProject(first.id)).toEqual(first)
    await expect(manager.listProjects({ cursor: 'invalid' })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  } finally {
    await manager.dispose()
    await rm(dir, { force: true, recursive: true })
  }
})

test('upgrades an existing database without changing project or native session identities', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'runtime-project-migration-'))
  const migrations = join(dir, 'old-migrations')
  await mkdir(migrations)
  await cp(
    new URL('../drizzle/20260916095414_faulty_captain_universe', import.meta.url),
    join(migrations, '20260916095414_faulty_captain_universe'),
    { recursive: true }
  )
  const client = await PGlite.create(join(dir, 'pgdata'))
  try {
    await migrate(drizzle({ client }), { migrationsFolder: migrations })
    await client.query(`INSERT INTO sessions (id, runtime, native_session_id, project_id, cwd, title, options, archived)
      VALUES ('old-1', 'manual', 'native-1', 'stable-project', '/old/path', 'Old', '{"model":"old-model"}', true),
      ('old-2', 'manual', 'native-2', 'stable-project', '/other/path', 'Other', '{}', false)`)
  } finally {
    await client.close()
  }
  const adapter = new ManualAdapter()
  const manager = await RuntimeManager.open({ dataDir: dir, runtimes: [adapter] })
  try {
    expect(await manager.getProject('stable-project')).toMatchObject({
      id: 'stable-project',
      workingDirectories: ['/old/path', '/other/path']
    })
    expect(await manager.getSession('old-1')).toMatchObject({
      archived: true,
      id: 'old-1',
      model: 'old-model',
      nativeSessionId: 'native-1',
      options: { model: 'old-model' },
      projectId: 'stable-project'
    })
    expect(await manager.getSession('old-2')).toMatchObject({ model: null, projectId: 'stable-project' })
    await manager.resumeSession('old-1')
    expect(adapter.resumed[0]).toMatchObject({
      model: 'old-model',
      nativeSessionId: 'native-1',
      projectId: 'stable-project'
    })
    expect((await manager.listSessions()).items.map(({ id }) => id)).toEqual(['old-2'])
  } finally {
    await manager.dispose()
    await rm(dir, { force: true, recursive: true })
  }
})
