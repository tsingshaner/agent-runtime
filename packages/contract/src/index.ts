import type { RouterContractClient } from '@orpc/contract'

import { health } from './health'
import { knowledge } from './knowledge'
import { mcp } from './mcp'
import { memory } from './memory'
import { memoryCore } from './memory-core'
import { projects } from './projects'
import { runs } from './runs'
import { sessions } from './sessions'
import { skills } from './skills'

export const contract = {
  health,
  knowledge,
  mcp,
  memory,
  memoryCore,
  projects,
  runs,
  sessions,
  skills
}

export { EventSchemas } from '@ag-ui/core'

export type { EventStream } from './runs'

export type RuntimeContractClient<C extends object = Record<never, never>> = RouterContractClient<typeof contract, C>
