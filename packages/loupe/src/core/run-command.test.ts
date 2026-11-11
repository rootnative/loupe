import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createRegistry, defineCommand } from './command'
import { LoupeError } from './errors'
import { runCommand } from './run-command'

const double = defineCommand({
  name: 'double',
  summary: 'Doubles a number',
  input: z.object({ value: z.number() }),
  output: z.object({ result: z.number() }),
  run: ({ value }) => ({ result: value * 2 }),
})

const greet = defineCommand({
  name: 'greet-user',
  summary: 'Says hello',
  input: z.object({ name: z.string().default('you') }),
  output: z.object({ text: z.string() }),
  run: async ({ name }) => ({ text: `Hello, ${name}` }),
})

describe('createRegistry', () => {
  it('lists the commands and finds one by name', () => {
    const registry = createRegistry([double, greet])

    expect(registry.list().map((command) => command.name)).toEqual([
      'double',
      'greet-user',
    ])
    expect(registry.get('double')).toBe(double)
    expect(registry.get('missing')).toBeUndefined()
  })

  it('refuses two commands with the same name', () => {
    expect(() => createRegistry([double, double])).toThrow(
      'Two commands have the name "double".',
    )
  })

  it.each(['OpenUrl', 'open_url', '-open', 'open-', '1tap', ''])(
    'refuses the name "%s"',
    (name) => {
      expect(() => createRegistry([{ ...double, name }])).toThrow(
        'must be kebab case',
      )
    },
  )
})

describe('runCommand', () => {
  const registry = createRegistry([double, greet])

  it('returns the data of a command that passes', async () => {
    expect(await runCommand(registry, 'double', { value: 21 })).toEqual({
      ok: true,
      command: 'double',
      data: { result: 42 },
    })
  })

  it('applies the defaults of the input schema', async () => {
    expect(await runCommand(registry, 'greet-user', {})).toEqual({
      ok: true,
      command: 'greet-user',
      data: { text: 'Hello, you' },
    })
  })

  it('fails for a command that does not exist', async () => {
    expect(await runCommand(registry, 'fly', {})).toEqual({
      ok: false,
      command: 'fly',
      error: { code: 'unknown_command', message: '"fly" is not a command.' },
    })
  })

  it('names the field of an invalid input', async () => {
    const result = await runCommand(registry, 'double', { value: 'two' })

    expect(result).toMatchObject({
      ok: false,
      command: 'double',
      error: { code: 'invalid_input' },
    })
    expect(result.ok === false && result.error.message).toMatch(/^value: /)
  })

  it('keeps the code of a LoupeError', async () => {
    const broken = defineCommand({
      ...double,
      name: 'broken',
      run: () => {
        throw new LoupeError('invalid_input', 'The value is too large.')
      },
    })

    expect(
      await runCommand(createRegistry([broken]), 'broken', { value: 1 }),
    ).toEqual({
      ok: false,
      command: 'broken',
      error: { code: 'invalid_input', message: 'The value is too large.' },
    })
  })

  it('reports any other error as internal', async () => {
    const broken = defineCommand({
      ...double,
      name: 'broken',
      run: async () => {
        throw new Error('boom')
      },
    })

    expect(
      await runCommand(createRegistry([broken]), 'broken', { value: 1 }),
    ).toEqual({
      ok: false,
      command: 'broken',
      error: { code: 'internal', message: 'boom' },
    })
  })

  it('refuses a result that the output schema does not accept', async () => {
    const broken = defineCommand({
      ...double,
      name: 'broken',
      run: () => ({ result: 'four' }) as unknown as { result: number },
    })

    expect(
      await runCommand(createRegistry([broken]), 'broken', { value: 1 }),
    ).toMatchObject({
      ok: false,
      command: 'broken',
      error: { code: 'invalid_output' },
    })
  })
})
