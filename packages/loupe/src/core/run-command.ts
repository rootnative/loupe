import { type z } from 'zod'
import { type Registry } from './command'
import { type CommandContext, createContext } from './context'
import { type ErrorCode, LoupeError } from './errors'

export interface CommandSuccess<T = unknown> {
  ok: true
  command: string
  data: T
}

export interface CommandFailure {
  ok: false
  command: string
  error: { code: ErrorCode; message: string }
}

export type CommandResult<T = unknown> = CommandSuccess<T> | CommandFailure

function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || 'input'}: ${issue.message}`)
    .join('; ')
}

function failure(
  command: string,
  code: ErrorCode,
  message: string,
): CommandFailure {
  return { ok: false, command, error: { code, message } }
}

/**
 * Checks the input, runs the command, and checks the output. It never
 * throws: each problem comes back as a failure with a code.
 */
export async function runCommand(
  registry: Registry,
  name: string,
  input: unknown,
  context: CommandContext = createContext(),
): Promise<CommandResult> {
  const command = registry.get(name)
  if (!command) {
    return failure(name, 'unknown_command', `"${name}" is not a command.`)
  }

  const parsedInput = command.input.safeParse(input)
  if (!parsedInput.success) {
    return failure(name, 'invalid_input', describeIssues(parsedInput.error))
  }
  // A call can wait behind another one, and its caller can cancel it there.
  if (context.signal?.aborted) {
    return failure(
      name,
      'cancelled',
      `The call was cancelled before ${name} started, so loupe didn't run it.`,
    )
  }

  let raw: unknown
  try {
    raw = await command.run(parsedInput.data, context)
  } catch (error) {
    if (error instanceof LoupeError) {
      return failure(name, error.code, error.message)
    }
    return failure(
      name,
      'internal',
      error instanceof Error ? error.message : String(error),
    )
  }

  const parsedOutput = command.output.safeParse(raw)
  if (!parsedOutput.success) {
    return failure(
      name,
      'invalid_output',
      `The command gave a result that its schema refuses. ${describeIssues(parsedOutput.error)}`,
    )
  }

  return { ok: true, command: name, data: parsedOutput.data }
}
