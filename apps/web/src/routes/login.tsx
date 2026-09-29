import { createFileRoute } from '@tanstack/react-router'

import { LoginFeature } from '../login'

export const Route = createFileRoute('/login')({
  component: () => (
    <main className="login-layout">
      <LoginFeature />
    </main>
  )
})
