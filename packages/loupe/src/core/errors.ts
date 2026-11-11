export const ERROR_CODES = [
  'unknown_command',
  'invalid_input',
  'invalid_output',
  'internal',
] as const

export type ErrorCode = (typeof ERROR_CODES)[number]

/** An error that a caller can act on by its code. */
export class LoupeError extends Error {
  readonly code: ErrorCode

  constructor(code: ErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'LoupeError'
    this.code = code
  }
}
