import { getLogger as $getLogger } from '@logtape/logtape'
import { toArray } from '@qingshaner/utility'

type Category = 'codex' | 'dsh' | 'deepagents' | 'runtime'

export const getLogger = (category?: Category | Category[]) =>
  $getLogger(category ? ['app', ...toArray<Category>(category)] : 'app')
