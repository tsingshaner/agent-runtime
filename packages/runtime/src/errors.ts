/**
 * An SDK error with a stable code and an optional underlying cause.
 */
export class RuntimeError extends Error {
  /**
   * Machine-readable code used to distinguish validation, lifecycle, and transport failures.
   */
  readonly code: string

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options)
    this.code = code
  }
}
