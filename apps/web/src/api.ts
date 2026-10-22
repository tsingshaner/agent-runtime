import { createORPCClient, ORPCError } from '@orpc/client'
import { OpenAPILink } from '@orpc/openapi/fetch'
import { contract } from '@qingshaner/runtime-contract'
import { QueryCache, QueryClient } from '@tanstack/react-query'

import type { RuntimeContractClient } from '@qingshaner/runtime-contract'

import { authClient } from './auth'

export const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false } },
  queryCache: new QueryCache({
    onError: (error) => {
      if (error instanceof ORPCError && error.code === 'UNAUTHORIZED') {
        queryClient.clear()
        void authClient.getSession()
      }
    }
  })
})
const link = new OpenAPILink(contract, { origin: window.location.origin })
export const api: RuntimeContractClient = createORPCClient(link)
// oRPC reserves `bind` on recursive clients for Function.prototype.bind.
export const bindProjectSkill: RuntimeContractClient['projects']['skills']['bind'] = createORPCClient(link, {
  path: ['projects', 'skills', 'bind']
})
