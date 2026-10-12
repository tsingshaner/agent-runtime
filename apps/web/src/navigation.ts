export const workspaceSearch = (search: Record<string, unknown>): { project?: string; session?: string } => ({
  project: typeof search.project === 'string' ? search.project : undefined,
  session: typeof search.session === 'string' ? search.session : undefined
})
