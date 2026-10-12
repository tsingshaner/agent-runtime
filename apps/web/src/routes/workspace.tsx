import { createFileRoute, redirect } from '@tanstack/react-router'

import { queryClient } from '../api'
import { authClient } from '../auth'
import { workspaceSearch } from '../navigation'
import { WorkspaceFeature } from '../workspace'

export const Route = createFileRoute('/workspace')({
  beforeLoad: async ({ search }) => {
    const { data, error } = await authClient.getSession()
    if (error) {
      throw new Error('Cannot check authentication')
    }
    if (!data) {
      queryClient.clear()
      throw redirect({ search, to: '/login' })
    }
  },
  component: WorkspaceFeature,
  validateSearch: workspaceSearch
})
