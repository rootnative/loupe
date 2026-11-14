import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { LoupeError } from '../../core/errors'
import { fakeContext, missingTool } from '../../testing/fake-exec'
import { adbCandidates, createAdb } from './adb'

const homeAdb = path.join('/sdk/home', 'platform-tools', 'adb')
const rootAdb = path.join('/sdk/root', 'platform-tools', 'adb')

describe('adbCandidates', () => {
  it('looks in ANDROID_HOME, then ANDROID_SDK_ROOT, then the PATH', () => {
    expect(
      adbCandidates({
        ANDROID_HOME: '/sdk/home',
        ANDROID_SDK_ROOT: '/sdk/root',
      }),
    ).toEqual([homeAdb, rootAdb, 'adb'])
  })

  it('looks on the PATH alone when no SDK is set', () => {
    expect(adbCandidates({})).toEqual(['adb'])
  })

  it('skips an empty variable and an SDK that both variables name', () => {
    expect(
      adbCandidates({ ANDROID_HOME: '', ANDROID_SDK_ROOT: '/sdk/root' }),
    ).toEqual([rootAdb, 'adb'])
    expect(
      adbCandidates({
        ANDROID_HOME: '/sdk/home',
        ANDROID_SDK_ROOT: '/sdk/home',
      }),
    ).toEqual([homeAdb, 'adb'])
  })
})

describe('createAdb', () => {
  it('returns stdout as text, and passes the arguments and the timeout', async () => {
    const { context, calls } = fakeContext(
      () => ({ stdout: 'List of devices attached\n' }),
      {
        ANDROID_HOME: '/sdk/home',
      },
    )

    const text = await createAdb(context).text(['devices', '-l'], {
      timeout: 5000,
    })

    expect(text).toBe('List of devices attached\n')
    expect(calls).toEqual([
      { file: homeAdb, args: ['devices', '-l'], options: { timeout: 5000 } },
    ])
  })

  it('returns binary stdout byte for byte', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const { context } = fakeContext(() => ({ stdout: png }))

    const bytes = await createAdb(context).run(['exec-out', 'screencap', '-p'])

    expect(bytes.equals(png)).toBe(true)
  })

  it('tries the next place when adb is not in the SDK, and keeps the one that works', async () => {
    const { context, calls } = fakeContext(
      ({ file }) => {
        if (file !== 'adb') throw missingTool(file)
        return { stdout: '' }
      },
      { ANDROID_HOME: '/sdk/home', ANDROID_SDK_ROOT: '/sdk/root' },
    )
    const adb = createAdb(context)

    await adb.run(['version'])
    await adb.run(['devices'])

    expect(calls.map((call) => call.file)).toEqual([
      homeAdb,
      rootAdb,
      'adb',
      'adb',
    ])
  })

  it('fails with tool_missing and names each place it looked', async () => {
    const { context } = fakeContext(
      ({ file }) => {
        throw missingTool(file)
      },
      { ANDROID_HOME: '/sdk/home' },
    )

    await expect(createAdb(context).run(['devices'])).rejects.toMatchObject({
      code: 'tool_missing',
      message: `loupe can't find adb. It looked for ${homeAdb}, and on the PATH. Install the Android SDK Platform-Tools, or set ANDROID_HOME to the folder of your Android SDK.`,
    })
  })

  it('says it looked on the PATH alone when no SDK is set', async () => {
    const { context } = fakeContext(({ file }) => {
      throw missingTool(file)
    })

    await expect(createAdb(context).run(['devices'])).rejects.toMatchObject({
      code: 'tool_missing',
      message: expect.stringContaining(
        "loupe can't find adb. It looked on the PATH.",
      ),
    })
  })

  it('does not try the next place after a timeout', async () => {
    const { context, calls } = fakeContext(
      () => {
        throw new LoupeError('timeout', "adb didn't finish in 30 s.")
      },
      { ANDROID_HOME: '/sdk/home' },
    )

    await expect(createAdb(context).run(['devices'])).rejects.toMatchObject({
      code: 'timeout',
    })
    expect(calls).toHaveLength(1)
  })

  it('fails with tool_failed and the stderr of adb on a non-zero exit', async () => {
    const { context } = fakeContext(() => ({
      code: 1,
      stdout: 'ignored',
      stderr: 'error: no devices/emulators found\n',
    }))

    await expect(
      createAdb(context).run(['shell', 'wm', 'size']),
    ).rejects.toMatchObject({
      code: 'tool_failed',
      message: 'adb exited with code 1: error: no devices/emulators found',
    })
  })

  it('uses stdout when stderr is empty, and keeps the arguments out of the message', async () => {
    const { context } = fakeContext(() => ({
      code: 255,
      stdout: 'cmd: Failure calling service\n',
    }))

    await expect(
      createAdb(context).run(['shell', 'input', 'text', 'secret']),
    ).rejects.toMatchObject({
      code: 'tool_failed',
      message: 'adb exited with code 255: cmd: Failure calling service',
    })
  })

  it('reports a stop on a signal, and cuts a long output', async () => {
    const { context } = fakeContext(() => ({
      code: null,
      stderr: 'x'.repeat(600),
    }))

    await expect(createAdb(context).run(['devices'])).rejects.toMatchObject({
      code: 'tool_failed',
      message: `adb stopped on a signal: ${'x'.repeat(500)}…`,
    })
  })

  it('reports an exit with no output', async () => {
    const { context } = fakeContext(() => ({ code: 1 }))

    await expect(createAdb(context).run(['devices'])).rejects.toMatchObject({
      code: 'tool_failed',
      message: 'adb exited with code 1.',
    })
  })
})
