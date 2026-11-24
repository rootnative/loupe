export const ERROR_CODES = [
  'unknown_command',
  'invalid_input',
  'invalid_output',
  'tool_missing',
  'tool_failed',
  'timeout',
  'no_device',
  'device_ambiguous',
  'device_unavailable',
  'unsupported',
  'orientation_locked',
  'app_not_in_front',
  'not_idle',
  'element_not_found',
  'element_ambiguous',
  'no_handler',
  'no_server',
  'cancelled',
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

/**
 * Throws `cancelled` when the caller cancelled the call. A long command
 * calls it at each point where it can stop with the device in a known
 * state, never in the middle of a touch.
 */
export function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new LoupeError(
      'cancelled',
      'The call was cancelled, so loupe stopped.',
    )
  }
}
