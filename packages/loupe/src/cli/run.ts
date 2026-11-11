import { registry as defaultRegistry } from '../commands'
import { type Registry } from '../core/command'
import { LoupeError } from '../core/errors'
import { type CommandResult, runCommand } from '../core/run-command'
import { version } from '../version'
import { parseCommandArgs } from './flags'
import { commandHelp, globalHelp } from './help'

export interface CliIO {
  out: (text: string) => void
  err: (text: string) => void
  /** True when a person reads the output in a terminal. */
  isTTY: boolean
}

const defaultIO: CliIO = {
  out: (text) => process.stdout.write(`${text}\n`),
  err: (text) => process.stderr.write(`${text}\n`),
  isTTY: process.stdout.isTTY === true,
}

export const EXIT_OK = 0
export const EXIT_FAILED = 1
export const EXIT_USAGE = 2

const JSON_FLAGS = new Set(['--json', '--no-json'])

function exitCodeOf(result: CommandResult): number {
  if (result.ok) return EXIT_OK
  const { code } = result.error
  return code === 'unknown_command' || code === 'invalid_input'
    ? EXIT_USAGE
    : EXIT_FAILED
}

export async function run(
  argv: readonly string[],
  io: CliIO = defaultIO,
  registry: Registry = defaultRegistry,
): Promise<number> {
  // The last of `--json` and `--no-json` wins. With neither, a terminal gets
  // text and a pipe gets JSON, so an agent never needs the flag.
  const jsonFlag = argv.findLast((arg) => JSON_FLAGS.has(arg))
  const json = jsonFlag ? jsonFlag === '--json' : !io.isTTY
  const [first, ...rest] = argv.filter((arg) => !JSON_FLAGS.has(arg))

  if (first === undefined || first === '--help' || first === '-h') {
    io.out(globalHelp(registry))
    return EXIT_OK
  }
  if (first === '--version' || first === '-v') {
    io.out(version)
    return EXIT_OK
  }

  const report = (result: CommandResult): number => {
    if (json) {
      io.out(JSON.stringify(result))
    } else if (result.ok) {
      const format = registry.get(result.command)?.format
      io.out(format?.(result.data) ?? JSON.stringify(result.data, null, 2))
    } else {
      io.err(`loupe ${result.command}: ${result.error.message}`)
      if (exitCodeOf(result) === EXIT_USAGE) {
        io.err('Run "loupe --help" for the commands and their options.')
      }
    }
    return exitCodeOf(result)
  }

  const command = registry.get(first)
  if (!command) return report(await runCommand(registry, first, {}))

  let parsed
  try {
    parsed = parseCommandArgs(command, rest)
  } catch (error) {
    if (!(error instanceof LoupeError)) throw error
    return report({
      ok: false,
      command: command.name,
      error: { code: error.code, message: error.message },
    })
  }

  if (parsed.help) {
    io.out(commandHelp(command))
    return EXIT_OK
  }

  return report(await runCommand(registry, command.name, parsed.input))
}
