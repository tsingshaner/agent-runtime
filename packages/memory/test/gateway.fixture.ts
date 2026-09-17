// cspell:ignore TDAI

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'

// Native subprocess fixture. Production never imports this file.
const config = JSON.parse(await readFile(process.env.TDAI_GATEWAY_CONFIG ?? '', 'utf8'))
await mkdir(config.data.baseDir, { recursive: true })
if (config.llm.model === 'exit') {
  process.exit(7)
}
if (config.llm.model === 'ignore-term') {
  process.on('SIGTERM', () => {})
}
const server = createServer(async (request, response) => {
  if (request.url === '/health') {
    response.writeHead(config.llm.model === 'unhealthy' ? 503 : 200)
    response.end('{}')
    return
  }
  if (request.headers.authorization !== `Bearer ${config.server.apiKey}`) {
    response.writeHead(401).end()
    return
  }
  const path = join(config.data.baseDir, 'data')
  if (request.method === 'PUT') {
    const chunks = []
    for await (const chunk of request) {
      chunks.push(chunk)
    }
    await writeFile(path, Buffer.concat(chunks))
  }
  response.end(await readFile(path).catch(() => Buffer.from('')))
})
server.listen(config.server.port, config.server.host, () => {
  process.stdout.write('Gateway listening on fixture\n')
})
