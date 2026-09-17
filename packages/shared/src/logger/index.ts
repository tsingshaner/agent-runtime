import { getLogger as $getLogger } from '@logtape/logtape'
import { toArray } from '@qingshaner/utility'

type Category = 'codex' | 'dsh' | 'deepagents' | 'runtime'

/**
 * Get a logger scoped to the application and optional runtime categories.
 *
 * @param category - One category or an ordered list of categories below app.
 */
export const getLogger = (category?: Category | Category[]) =>
  $getLogger(category ? ['app', ...toArray<Category>(category)] : 'app')
