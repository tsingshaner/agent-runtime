import { createFileRoute } from '@tanstack/react-router'

import { LoginFeature } from '../login'
import { workspaceSearch } from '../navigation'

export const Route = createFileRoute('/login')({
  component: () => (
    <main className="login-layout">
      <LoginFeature />
    </main>
  ),
  validateSearch: workspaceSearch
})
