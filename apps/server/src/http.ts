// cspell:ignore nosniff
import type { IncomingMessage, ServerResponse } from 'node:http'
import { RuntimeError } from '@qingshaner/runtime'
import * as v from 'valibot'

const object = v.record(v.string(), v.unknown())
export const parse = <S extends v.GenericSchema>(schema: S, input: unknown): v.InferOutput<S> => {
  const result = v.safeParse(schema, input)
  if (!result.success) {
    throw new RuntimeError('INVALID_INPUT', 'Invalid input')
  }
  return result.output
}
export const body = async (request: IncomingMessage) => {
  if (request.headers['content-type']?.split(';')[0] !== 'application/json') {
    throw new RuntimeError('INVALID_INPUT', 'Expected JSON')
  }
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > 1024 * 1024) {
      throw new RuntimeError('INVALID_INPUT', 'Body too large')
    }
    chunks.push(chunk)
  }
  try {
    return parse(object, JSON.parse(Buffer.concat(chunks).toString()))
  } catch {
    throw new RuntimeError('INVALID_INPUT', 'Invalid JSON')
  }
}
export const json = (response: ServerResponse, value: unknown, status = 200) => {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json',
    'x-content-type-options': 'nosniff'
  })
  response.end(JSON.stringify(value ?? {}))
}
