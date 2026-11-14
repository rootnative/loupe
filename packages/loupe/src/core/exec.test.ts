import { describe, expect, it } from 'vitest'
import { nodeExec } from './exec'

const node = process.execPath

describe('nodeExec', () => {
  it('returns the exit code, stdout and stderr', async () => {
    const result = await nodeExec(node, [
      '-e',
      'process.stdout.write("out"); process.stderr.write("err"); process.exitCode = 3',
    ])

    expect(result.code).toBe(3)
    expect(result.stdout.toString()).toBe('out')
    expect(result.stderr.toString()).toBe('err')
  })

  it('keeps binary output byte for byte', async () => {
    const bytes = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]
    const result = await nodeExec(node, [
      '-e',
      `process.stdout.write(Buffer.from([${bytes.join(',')}]))`,
    ])

    expect([...result.stdout]).toEqual(bytes)
  })

  it('passes each argument as it is, with no shell', async () => {
    const args = ['$HOME', 'a b', '; echo no', '"quoted"', '*', '%PATH%']
    const result = await nodeExec(node, [
      '-e',
      'process.stdout.write(JSON.stringify(process.argv.slice(1)))',
      ...args,
    ])

    expect(JSON.parse(result.stdout.toString())).toEqual(args)
  })

  it('stops a tool that runs past the timeout', async () => {
    const started = Date.now()

    await expect(
      nodeExec(node, ['-e', 'setTimeout(() => {}, 20000)'], { timeout: 300 }),
    ).rejects.toMatchObject({
      code: 'timeout',
      message: expect.stringContaining("didn't finish in 300 ms"),
    })
    expect(Date.now() - started).toBeLessThan(10_000)
  })

  it('fails with tool_missing for a tool that does not exist', async () => {
    await expect(nodeExec('loupe-test-no-such-tool', [])).rejects.toMatchObject(
      {
        code: 'tool_missing',
        message: 'loupe can\'t find "loupe-test-no-such-tool".',
      },
    )
  })
})
