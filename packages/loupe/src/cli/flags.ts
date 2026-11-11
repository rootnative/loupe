import { parseArgs } from 'node:util'
import { z } from 'zod'
import { type Command } from '../core/command'
import { LoupeError } from '../core/errors'

export type FlagKind = 'string' | 'number' | 'boolean'

export interface Flag {
  /** The input field, for example `holdEnd`. */
  key: string
  /** The flag without the dashes, for example `hold-end`. */
  name: string
  kind: FlagKind
  /** The field is a list, so the flag can repeat. */
  multiple: boolean
  required: boolean
  positional: boolean
  description?: string
  choices?: readonly string[]
  defaultValue?: unknown
}

interface SchemaNode {
  type?: unknown
  enum?: unknown
  items?: SchemaNode
  description?: unknown
  default?: unknown
}

const RESERVED = new Set(['help', 'json'])

function kebab(key: string): string {
  return key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)
}

function kindOf(node: SchemaNode | undefined): FlagKind | undefined {
  switch (node?.type) {
    case 'string':
      return 'string'
    case 'number':
    case 'integer':
      return 'number'
    case 'boolean':
      return 'boolean'
    default:
      return undefined
  }
}

/**
 * Reads the flags of a command from the JSON Schema of its input. It throws
 * for a field that a flag can't carry, so a test finds that command early.
 */
export function flagsOf(command: Command): Flag[] {
  const schema = z.toJSONSchema(command.input, { io: 'input' }) as {
    properties?: Record<string, SchemaNode>
    required?: string[]
  }
  const required = new Set(schema.required)
  const positionals = new Set<string>(command.positionals)

  const flags = Object.entries(schema.properties ?? {}).map(
    ([key, node]): Flag => {
      const name = kebab(key)
      const multiple = node.type === 'array'
      const leaf = multiple ? node.items : node
      const kind = kindOf(leaf)
      const positional = positionals.has(key)

      if (RESERVED.has(name)) {
        throw new Error(
          `${command.name}: the field "${key}" has the name of a CLI flag.`,
        )
      }
      if (!kind) {
        throw new Error(
          `${command.name}: the field "${key}" must be a string, a number, a boolean, or a list of these.`,
        )
      }
      if (positional && (multiple || kind === 'boolean')) {
        throw new Error(
          `${command.name}: the positional field "${key}" must be one string or one number.`,
        )
      }

      return {
        key,
        name,
        kind,
        multiple,
        required: required.has(key),
        positional,
        description:
          typeof node.description === 'string' ? node.description : undefined,
        choices: Array.isArray(leaf?.enum) ? leaf.enum.map(String) : undefined,
        defaultValue: node.default,
      }
    },
  )

  for (const key of positionals) {
    if (!flags.some((flag) => flag.key === key)) {
      throw new Error(
        `${command.name}: the positional "${key}" is not an input field.`,
      )
    }
  }

  return flags
}

function convert(flag: Flag, raw: string | boolean): unknown {
  if (flag.kind !== 'number' || typeof raw !== 'string') return raw
  // Text that isn't a number stays as it is, so the schema names the field.
  const value = raw.trim() === '' ? Number.NaN : Number(raw)
  return Number.isNaN(value) ? raw : value
}

export interface ParsedArgs {
  help: boolean
  input: Record<string, unknown>
}

/** Turns the arguments after the command name into the command input. */
export function parseCommandArgs(
  command: Command,
  args: readonly string[],
): ParsedArgs {
  const flags = flagsOf(command)

  let parsed
  try {
    parsed = parseArgs({
      args: [...args],
      options: {
        help: { type: 'boolean', short: 'h' },
        ...Object.fromEntries(
          flags.map((flag) => [
            flag.name,
            {
              type: flag.kind === 'boolean' ? 'boolean' : 'string',
              multiple: flag.multiple,
            } as const,
          ]),
        ),
      },
      allowPositionals: true,
      allowNegative: true,
      strict: true,
    })
  } catch (error) {
    throw new LoupeError(
      'invalid_input',
      error instanceof Error ? error.message : String(error),
    )
  }

  const values: Record<string, string | boolean | (string | boolean)[]> =
    parsed.values
  const input: Record<string, unknown> = {}

  for (const flag of flags) {
    const raw = values[flag.name]
    if (raw === undefined) continue
    input[flag.key] = Array.isArray(raw)
      ? raw.map((item) => convert(flag, item))
      : convert(flag, raw)
  }

  const order = command.positionals ?? []
  if (parsed.positionals.length > order.length) {
    const extra = parsed.positionals[order.length]
    throw new LoupeError(
      'invalid_input',
      `"${extra}" is one argument too many for ${command.name}.`,
    )
  }

  parsed.positionals.forEach((raw, index) => {
    const flag = flags.find((item) => item.key === order[index])
    if (!flag) return
    if (flag.key in input) {
      throw new LoupeError(
        'invalid_input',
        `${flag.key} has two values: one by position and one from --${flag.name}.`,
      )
    }
    input[flag.key] = convert(flag, raw)
  })

  return { help: parsed.values.help === true, input }
}
