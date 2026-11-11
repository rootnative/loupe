import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { registry } from '../commands'
import { defineCommand } from '../core/command'
import { flagsOf, parseCommandArgs } from './flags'

const drag = defineCommand({
  name: 'drag',
  summary: 'Moves a touch',
  input: z.object({
    from: z.string().describe('The start point'),
    holdEnd: z.number().default(0),
    side: z.enum(['left', 'right']).optional(),
    slow: z.boolean().default(false),
    tags: z.array(z.string()).default([]),
    sizes: z.array(z.number()).optional(),
  }),
  output: z.object({}),
  positionals: ['from'],
  run: () => ({}),
})

const base = {
  name: 'sample',
  summary: 'A sample',
  output: z.object({}),
  run: () => ({}),
}

describe('flagsOf', () => {
  it('reads one flag per input field', () => {
    expect(flagsOf(drag)).toEqual([
      {
        key: 'from',
        name: 'from',
        kind: 'string',
        multiple: false,
        required: true,
        positional: true,
        description: 'The start point',
        choices: undefined,
        defaultValue: undefined,
      },
      expect.objectContaining({
        key: 'holdEnd',
        name: 'hold-end',
        kind: 'number',
        required: false,
        defaultValue: 0,
      }),
      expect.objectContaining({ key: 'side', choices: ['left', 'right'] }),
      expect.objectContaining({ key: 'slow', kind: 'boolean' }),
      expect.objectContaining({ key: 'tags', kind: 'string', multiple: true }),
      expect.objectContaining({ key: 'sizes', kind: 'number', multiple: true }),
    ])
  })

  it('refuses a field that a flag cannot carry', () => {
    const nested = defineCommand({
      ...base,
      input: z.object({ point: z.object({ x: z.number() }) }),
    })

    expect(() => flagsOf(nested)).toThrow('the field "point" must be a string')
  })

  it('refuses a field with the name of a CLI flag', () => {
    const clash = defineCommand({
      ...base,
      input: z.object({ json: z.boolean() }),
    })

    expect(() => flagsOf(clash)).toThrow('has the name of a CLI flag')
  })

  it('refuses a positional that is not one string or one number', () => {
    const list = defineCommand({
      ...base,
      input: z.object({ tags: z.array(z.string()) }),
      positionals: ['tags'],
    })

    expect(() => flagsOf(list)).toThrow('must be one string or one number')
  })

  it('reads the flags of every built-in command', () => {
    for (const command of registry.list()) {
      expect(() => flagsOf(command)).not.toThrow()
    }
  })
})

describe('parseCommandArgs', () => {
  it('reads positionals, numbers, booleans and lists', () => {
    expect(
      parseCommandArgs(drag, [
        '10,20',
        '--hold-end',
        '0.5',
        '--slow',
        '--tags',
        'a',
        '--tags',
        'b',
        '--sizes=1',
        '--sizes=2',
      ]),
    ).toEqual({
      help: false,
      input: {
        from: '10,20',
        holdEnd: 0.5,
        slow: true,
        tags: ['a', 'b'],
        sizes: [1, 2],
      },
    })
  })

  it('leaves out a flag that was not given, so the schema default applies', () => {
    expect(parseCommandArgs(drag, ['--from', 'a'])).toEqual({
      help: false,
      input: { from: 'a' },
    })
  })

  it('turns a boolean off with --no-', () => {
    expect(parseCommandArgs(drag, ['a', '--no-slow']).input).toEqual({
      from: 'a',
      slow: false,
    })
  })

  it('keeps text that is not a number, for the schema to refuse', () => {
    expect(parseCommandArgs(drag, ['a', '--hold-end', 'long']).input).toEqual({
      from: 'a',
      holdEnd: 'long',
    })
  })

  it('reads --help and -h', () => {
    expect(parseCommandArgs(drag, ['--help']).help).toBe(true)
    expect(parseCommandArgs(drag, ['-h']).help).toBe(true)
  })

  it.each([
    ['a flag that does not exist', ['a', '--fast'], '--fast'],
    ['one argument too many', ['a', 'b'], '"b" is one argument too many'],
    ['a field given twice', ['a', '--from', 'b'], 'from has two values'],
  ])('refuses %s', (_case, args, message) => {
    expect(() => parseCommandArgs(drag, args)).toThrow(message)
  })
})
