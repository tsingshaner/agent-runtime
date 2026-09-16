import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  dialect: 'postgresql',
  out: './packages/runtime/drizzle',
  schema: './packages/runtime/src/schema.ts'
})
