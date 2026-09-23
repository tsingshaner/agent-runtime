import { configuredService } from './main.ts'

export default { fetch: async (request: Request) => (await configuredService()).fetch(request) }
