import { type Command, type Registry } from '../core/command'
import { type Flag, flagsOf } from './flags'

function columns(rows: readonly (readonly [string, string])[]): string {
  const width = Math.max(0, ...rows.map(([left]) => left.length))
  return rows
    .map(([left, right]) => `  ${left.padEnd(width)}  ${right}`.trimEnd())
    .join('\n')
}

const SHARED_OPTIONS = [
  ['--json', 'Print JSON. The default when the output is not a terminal'],
  ['--no-json', 'Print text for a person'],
  ['-h, --help', 'Print this help'],
] as const

export function globalHelp(registry: Registry): string {
  const commands = columns(
    registry.list().map((command) => [command.name, command.summary]),
  )

  return `Usage: loupe <command> [options]

Commands:
${commands}

Options:
${columns([...SHARED_OPTIONS, ['-v, --version', 'Print the version']])}

Run "loupe <command> --help" for the options of one command.`
}

function flagLeft(flag: Flag): string {
  if (flag.kind === 'boolean') return `--${flag.name}`
  const value = flag.choices ? flag.choices.join('|') : `<${flag.kind}>`
  return `--${flag.name} ${value}`
}

function flagRight(flag: Flag): string {
  const notes: string[] = []
  if (flag.required) notes.push('required')
  if (flag.multiple) notes.push('can repeat')
  if (
    flag.defaultValue !== undefined &&
    !(Array.isArray(flag.defaultValue) && flag.defaultValue.length === 0)
  ) {
    notes.push(`default: ${JSON.stringify(flag.defaultValue)}`)
  }

  const note = notes.length > 0 ? `(${notes.join(', ')})` : ''
  return [flag.description, note].filter(Boolean).join(' ')
}

export function commandHelp(command: Command): string {
  const flags = flagsOf(command)
  const positionals = (command.positionals ?? [])
    .map((key) => flags.find((flag) => flag.key === key))
    .filter((flag) => flag !== undefined)
    .map((flag) => (flag.required ? `<${flag.name}>` : `[${flag.name}]`))

  const usage = ['loupe', command.name, ...positionals, '[options]'].join(' ')
  const options = columns([
    ...flags.map((flag) => [flagLeft(flag), flagRight(flag)] as const),
    ...SHARED_OPTIONS,
  ])

  return `Usage: ${usage}

${command.summary}

Options:
${options}`
}
