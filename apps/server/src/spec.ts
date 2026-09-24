import { OpenAPIGenerator } from '@orpc/openapi'
import { ZodToJsonSchemaConverter } from '@orpc/zod'
import { contract, EventSchemas } from '@qingshaner/runtime-contract'
import { zodToJsonSchema } from 'zod-to-json-schema'

const generator = new OpenAPIGenerator({
  converters: [
    // AG-UI's Zod 3 schema must be handled before the Zod 4 converter.
    {
      condition: (schema) => schema === EventSchemas,
      convert: () => [
        zodToJsonSchema(EventSchemas as unknown as Parameters<typeof zodToJsonSchema>[0], { target: 'openApi3' }),
        false
      ]
    },
    new ZodToJsonSchemaConverter()
  ]
})
let spec: ReturnType<typeof generator.generate> | undefined
export const specification = (): ReturnType<typeof generator.generate> =>
  (spec ??= generator.generate(contract, {
    base: {
      components: { securitySchemes: { bearerAuth: { scheme: 'bearer', type: 'http' } } },
      info: { title: 'Agent Runtime', version: '1.0.0' },
      security: [{ bearerAuth: [] }],
      servers: [{ url: '/' }]
    }
  }))
