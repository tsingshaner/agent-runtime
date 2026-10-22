export const workspaceSearch = (
  search: Record<string, unknown>
): { project?: string; session?: string; view?: 'skills' | 'mcp' } => ({
  project: typeof search.project === 'string' ? search.project : undefined,
  session: typeof search.session === 'string' ? search.session : undefined,
  view: search.view === 'skills' || search.view === 'mcp' ? search.view : undefined
})
