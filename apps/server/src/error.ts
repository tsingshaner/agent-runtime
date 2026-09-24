import { ORPCError } from '@orpc/server'

export const safeError = (error: unknown): ORPCError<string, unknown> => {
  if (error instanceof ORPCError) {
    return error
  }
  const code =
    error instanceof Error && 'code' in error && typeof error.code === 'string' && /^[A-Z_]+$/.test(error.code)
      ? error.code
      : 'INTERNAL_ERROR'
  if (['INVALID_INPUT', 'INVALID_PATH', 'INVALID_CONFIG', 'INVALID_SKILL'].includes(code)) {
    return new ORPCError('BAD_REQUEST', { message: 'Invalid input' })
  }
  if (code.endsWith('_NOT_FOUND')) {
    return new ORPCError('NOT_FOUND', { message: 'Not found' })
  }
  if (code === 'EVENTS_CLEARED') {
    return new ORPCError('GONE', { message: 'Event history cleared' })
  }
  if (code === 'DISPOSED') {
    return new ORPCError('SERVICE_UNAVAILABLE', { message: 'Service unavailable' })
  }
  if (code === 'INTERNAL_ERROR' || code === 'STORAGE_ERROR') {
    return new ORPCError('INTERNAL_SERVER_ERROR', { message: 'Internal error' })
  }
  return new ORPCError('CONFLICT', { data: { code }, message: 'Operation conflicts with current state' })
}
