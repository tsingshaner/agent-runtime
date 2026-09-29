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
export const api: RuntimeContractClient = createORPCClient(
  new OpenAPILink(contract, { origin: window.location.origin })
)
