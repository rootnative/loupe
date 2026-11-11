import { describe, expect, it } from 'vitest'
import pkg from '../../package.json'
import { EXIT_OK, EXIT_USAGE, run } from './run'

function capture() {
  const out: string[] = []
  const err: string[] = []
  return {
    out,
    err,
    streams: {
      out: (text: string) => out.push(text),
      err: (text: string) => err.push(text),
    },
  }
}

describe('run', () => {
  it.each(['--version', '-v'])(
    'prints the package version for %s',
    async (flag) => {
      const io = capture()

      expect(await run([flag], io.streams)).toBe(EXIT_OK)
      expect(io.out).toEqual([pkg.version])
      expect(io.err).toEqual([])
    },
  )

  it.each([[[]], [['--help']], [['-h']]])(
    'prints the usage for %j',
    async (argv) => {
      const io = capture()

      expect(await run(argv, io.streams)).toBe(EXIT_OK)
      expect(io.out.join('\n')).toContain('Usage: loupe')
    },
  )

  it('rejects a command that does not exist', async () => {
    const io = capture()

    expect(await run(['fly'], io.streams)).toBe(EXIT_USAGE)
    expect(io.out).toEqual([])
    expect(io.err.join('\n')).toContain('"fly" is not a command')
  })
})
