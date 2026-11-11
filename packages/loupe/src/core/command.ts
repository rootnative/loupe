import { type z } from 'zod'

/**
 * One command, defined once. The CLI and the MCP server are both made from
 * this definition, so the two can't drift apart.
 */
export interface Command<
  I extends z.ZodObject = z.ZodObject,
  O extends z.ZodType = z.ZodType,
> {
  /** Kebab case, for example `open-url`. */
  name: string
  /** One line for the help text and the MCP tool description. */
  summary: string
  input: I
  output: O
  /**
   * Input fields that the CLI also takes by position, in order:
   * `open-url <url>`. Each one still works as a flag.
   */
  positionals?: readonly (keyof z.output<I> & string)[]
  // `run` and `format` use the method form on purpose. A method parameter is
  // bivariant, so a list can hold commands with different input types.
  run(input: z.output<I>): Promise<z.input<O>> | z.input<O>
  /** A short summary for a person at a terminal. JSON is the default. */
  format?(data: z.output<O>): string
}

export function defineCommand<I extends z.ZodObject, O extends z.ZodType>(
  command: Command<I, O>,
): Command<I, O> {
  return command
}

export interface Registry {
  list(): readonly Command[]
  get(name: string): Command | undefined
}

const COMMAND_NAME = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/

export function createRegistry(commands: readonly Command[]): Registry {
  const byName = new Map<string, Command>()

  for (const command of commands) {
    if (!COMMAND_NAME.test(command.name)) {
      throw new Error(
        `The command name "${command.name}" must be kebab case, for example "open-url".`,
      )
    }
    if (byName.has(command.name)) {
      throw new Error(`Two commands have the name "${command.name}".`)
    }
    byName.set(command.name, command)
  }

  const list = [...byName.values()]

  return {
    list: () => list,
    get: (name) => byName.get(name),
  }
}
