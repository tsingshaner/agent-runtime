import { createFileRoute, redirect } from '@tanstack/react-router'

import { queryClient } from '../api'
import { authClient } from '../auth'
import { WorkspaceFeature } from '../workspace'

export const Route = createFileRoute('/workspace')({
  beforeLoad: async () => {
    const { data, error } = await authClient.getSession()
    if (error) {
      throw new Error('Cannot check authentication')
    }
    if (!data) {
      queryClient.clear()
      throw redirect({ to: '/login' })
    }
  },
  component: WorkspaceFeature,
  validateSearch: (search: Record<string, unknown>): { project?: string; session?: string } => ({
    project: typeof search.project === 'string' ? search.project : undefined,
    session: typeof search.session === 'string' ? search.session : undefined
  })
})
