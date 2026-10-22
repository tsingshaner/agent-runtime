export const workspaceSearch = (
  search: Record<string, unknown>
): { project?: string; session?: string; view?: 'skills' } => ({
  project: typeof search.project === 'string' ? search.project : undefined,
  session: typeof search.session === 'string' ? search.session : undefined,
  view: search.view === 'skills' ? 'skills' : undefined
})
