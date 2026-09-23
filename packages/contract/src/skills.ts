import { openapi } from '@orpc/openapi'
import * as z from 'zod/mini'

import { base, byId, done, idBody, idQuery, withBody } from './base'
import * as s from './schemas'

const skillsBase = base.meta(openapi({ tags: ['Skills'] }))

export const skills = {
  delete: skillsBase
    .meta(
      openapi({
        description:
          'Deletes the managed skill copy after existing runs drain and reapplies shared resources. Preserves the original imported source directory.',
        method: 'DELETE',
        operationId: 'deleteSkill',
        path: '/skills/{id}',
        summary: 'Delete a managed skill'
      })
    )
    .input(byId)
    .output(done),
  edit: skillsBase
    .meta(
      openapi({
        description:
          'Atomically replaces a file within the managed skill directory after existing runs drain, then reapplies shared project resources.',
        method: 'PATCH',
        operationId: 'editSkillFile',
        path: '/skills/{id}/file',
        summary: 'Edit a managed skill file'
      })
    )
    .input(idBody(s.document))
    .output(done),
  get: skillsBase
    .meta(
      openapi({
        description: 'Returns managed skill metadata and its copied directory location.',
        method: 'GET',
        operationId: 'getSkill',
        path: '/skills/{id}',
        summary: 'Get a managed skill'
      })
    )
    .input(byId)
    .output(s.skill),
  import: skillsBase
    .meta(
      openapi({
        description:
          'Copies a local skill directory, including scripts and references, into managed storage after validating its SKILL.md metadata.',
        method: 'POST',
        operationId: 'importSkill',
        path: '/skills',
        summary: 'Import a local skill'
      })
    )
    .input(withBody(z.strictObject({ source: s.text })))
    .output(s.skill),
  list: skillsBase
    .meta(
      openapi({
        description: 'Lists imported skills independently of project bindings.',
        method: 'GET',
        operationId: 'listSkills',
        path: '/skills',
        summary: 'List managed skills'
      })
    )
    .output(z.array(s.skill)),
  read: skillsBase
    .meta(
      openapi({
        description:
          'Reads a file relative to the managed skill directory. The path defaults to SKILL.md; paths outside the directory are rejected.',
        method: 'GET',
        operationId: 'readSkillFile',
        path: '/skills/{id}/file',
        summary: 'Read a managed skill file'
      })
    )
    .input(idQuery(z.strictObject({ path: z.prefault(s.text, 'SKILL.md') })))
    .output(s.content)
}
