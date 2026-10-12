import { writeFile } from 'node:fs/promises'

import { presentationInstructions } from '../src/openui-schema.ts'

// The server consumes the same component contract without importing React or the browser runtime.
await writeFile(
  new URL('../../server/src/openui-prompt.json', import.meta.url),
  `${JSON.stringify(presentationInstructions)}\n`
)
