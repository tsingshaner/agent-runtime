import { createAuthClient } from 'better-auth/react'

export const authClient = createAuthClient({
  basePath: '/auth',
  plugins: [
    {
      getActions: ($fetch, $store) => ({
        signInToken: async (token: string) => {
          const result = await $fetch<{ authenticated: boolean }>('/sign-in/token', { body: { token }, method: 'POST' })
          if (!result.error) {
            $store.notify('$sessionSignal')
          }
          return result
        }
      }),
      id: 'access-token'
    }
  ]
})
