import { mkdir, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'

import type { ResourceSnapshot } from '@qingshaner/runtime'

/** Keep live resource files in their managed location; expose only explicit skill links. */
export const resourcePlugins = async (directory: string, snapshot?: ResourceSnapshot) => {
  if (!snapshot) {
    return []
  }
  const root = join(directory, 'skills')
  await rm(root, { force: true, recursive: true })
  await mkdir(root, { mode: 0o700 })
  await Promise.all(snapshot.skillDirectories.map((path, index) => symlink(path, join(root, `skill-${index}`), 'dir')))
  return [
    {
      config: {
        failOnStartupError: true,
        headers: { Authorization: snapshot.token },
        reconnect: { enabled: false },
        serverName: 'project',
        transport: 'streamable-http',
        url: snapshot.url
      },
      id: 'project-mcp',
      name: '@deepseek-ai/dsh-mcp-client'
    },
    { id: 'skills', name: '@deepseek-ai/dsh-skill' },
    {
      config: { customSkillDirs: [root], includeDefaultRoots: false, watch: false },
      id: 'project-skills',
      name: '@deepseek-ai/dsh-skill-filesystem'
    },
    { id: 'skill-tool', name: '@deepseek-ai/dsh-tool-skill' }
  ]
}
