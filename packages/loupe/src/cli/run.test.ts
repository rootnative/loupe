import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import pkg from '../../package.json'
import { createRegistry, defineCommand } from '../core/command'
import { EXIT_FAILED, EXIT_OK, EXIT_USAGE, run } from './run'

function capture(isTTY = false) {
  const out: string[] = []
  const err: string[] = []
  return {
    out,
    err,
    io: {
      out: (text: string) => out.push(text),
      err: (text: string) => err.push(text),
      isTTY,
    },
  }
}

const move = defineCommand({
  name: 'move',
  summary: 'Moves a thing',
  input: z.object({ to: z.string(), steps: z.number().default(1) }),
  output: z.object({ text: z.string() }),
  positionals: ['to'],
  run: ({ to, steps }) => {
    if (to === 'nowhere') throw new Error('No such place.')
    return { text: `${to} in ${steps}` }
  },
  format: (data) => `Moved: ${data.text}`,
})

const raw = defineCommand({
  name: 'raw',
  summary: 'Has no text format',
  input: z.object({}),
  output: z.object({ value: z.number() }),
  run: () => ({ value: 7 }),
})

const registry = createRegistry([move, raw])

describe('run, without a command', () => {
  it.each(['--version', '-v'])('prints the version for %s', async (flag) => {
    const { io, out, err } = capture()

    expect(await run([flag], io)).toBe(EXIT_OK)
    expect(out).toEqual([pkg.version])
    expect(err).toEqual([])
  })

  it.each([[[]], [['--help']], [['-h']]])(
    'lists the commands for %j',
    async (argv) => {
      const { io, out } = capture()

      expect(await run(argv, io, registry)).toBe(EXIT_OK)
      expect(out.join('\n')).toContain('Usage: loupe <command>')
      expect(out.join('\n')).toMatch(/move\s+Moves a thing/)
    },
  )
})

describe('run, JSON output', () => {
  it('prints the result as JSON when the output is not a terminal', async () => {
    const { io, out } = capture(false)

    expect(await run(['move', 'home', '--steps', '3'], io, registry)).toBe(
      EXIT_OK,
    )
    expect(out.map((line) => JSON.parse(line))).toEqual([
      { ok: true, command: 'move', data: { text: 'home in 3' } },
    ])
  })

  it('prints JSON in a terminal with --json, before or after the command', async () => {
    for (const argv of [
      ['--json', 'move', 'home'],
      ['move', 'home', '--json'],
    ]) {
      const { io, out } = capture(true)

      expect(await run(argv, io, registry)).toBe(EXIT_OK)
      expect(JSON.parse(out[0] ?? '')).toMatchObject({ ok: true })
    }
  })

  it('prints a failure as JSON on stdout, with exit code 1', async () => {
    const { io, out, err } = capture()

    expect(await run(['move', 'nowhere'], io, registry)).toBe(EXIT_FAILED)
    expect(JSON.parse(out[0] ?? '')).toEqual({
      ok: false,
      command: 'move',
      error: { code: 'internal', message: 'No such place.' },
    })
    expect(err).toEqual([])
  })

  it.each([
    ['a command that does not exist', ['fly'], 'unknown_command'],
    ['a flag that does not exist', ['move', 'home', '--fast'], 'invalid_input'],
    ['a missing required field', ['move'], 'invalid_input'],
    ['a wrong type', ['move', 'home', '--steps', 'two'], 'invalid_input'],
    ['one argument too many', ['move', 'home', 'again'], 'invalid_input'],
  ])('exits with 2 for %s', async (_case, argv, code) => {
    const { io, out } = capture()

    expect(await run(argv, io, registry)).toBe(EXIT_USAGE)
    expect(JSON.parse(out[0] ?? '')).toMatchObject({
      ok: false,
      error: { code },
    })
  })
})

describe('run, text output', () => {
  it('prints the text format in a terminal', async () => {
    const { io, out } = capture(true)

    expect(await run(['move', '--to', 'home'], io, registry)).toBe(EXIT_OK)
    expect(out).toEqual(['Moved: home in 1'])
  })

  it('prints text through a pipe with --no-json', async () => {
    const { io, out } = capture(false)

    expect(await run(['move', 'home', '--no-json'], io, registry)).toBe(EXIT_OK)
    expect(out).toEqual(['Moved: home in 1'])
  })

  it('prints the data when the command has no text format', async () => {
    const { io, out } = capture(true)

    expect(await run(['raw'], io, registry)).toBe(EXIT_OK)
    expect(JSON.parse(out.join('\n'))).toEqual({ value: 7 })
  })

  it('prints a failure on stderr', async () => {
    const { io, out, err } = capture(true)

    expect(await run(['move', 'nowhere'], io, registry)).toBe(EXIT_FAILED)
    expect(out).toEqual([])
    expect(err).toEqual(['loupe move: No such place.'])
  })

  it('points to the help after a usage error', async () => {
    const { io, err } = capture(true)

    expect(await run(['fly'], io, registry)).toBe(EXIT_USAGE)
    expect(err[0]).toBe('loupe fly: "fly" is not a command.')
    expect(err[1]).toContain('loupe --help')
  })

  it('prints the help of one command', async () => {
    const { io, out } = capture(true)

    expect(await run(['move', '--help'], io, registry)).toBe(EXIT_OK)
    expect(out.join('\n')).toContain('Usage: loupe move <to> [options]')
    expect(out.join('\n')).toMatch(/--steps <number>\s+\(default: 1\)/)
  })
})

describe('run, the built-in commands', () => {
  it('runs version', async () => {
    const { io, out } = capture()

    expect(await run(['version'], io)).toBe(EXIT_OK)
    expect(JSON.parse(out[0] ?? '')).toEqual({
      ok: true,
      command: 'version',
      data: {
        loupe: pkg.version,
        node: process.version,
        platform: process.platform,
        arch: process.arch,
      },
    })
  })
})
