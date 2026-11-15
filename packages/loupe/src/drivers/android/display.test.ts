import { describe, expect, it } from 'vitest'
import { byCommand, type FakeRun, fakeContext } from '../../testing/fake-exec'
import { API_LEVELS, recorded, recordedText } from '../../testing/fixtures'
import { selectAndroidDevice } from './devices'
import { readAndroidDisplay, rotateAndroid } from './display'

const ADB = 'adb -s emulator-5554 shell'
const DUMP = `${ADB} dumpsys window displays`
const AUTO_ROTATE_OFF = `${ADB} settings put system accelerometer_rotation 0`

function emulator(
  level: number,
  runs: Readonly<Record<string, FakeRun | readonly FakeRun[]>>,
) {
  const api = `api-${level}`
  const { context, calls } = fakeContext(
    byCommand({
      'adb devices -l': recorded(`${api}/host/adb-devices-l.txt`),
      [`${ADB} getprop`]: recorded(`${api}/device/getprop.txt`),
      ...runs,
    }),
  )
  return { calls, target: () => selectAndroidDevice(context) }
}

function dump(level: number, rotation: number, screen: string): FakeRun {
  return recorded(
    `api-${level}/none/rotation-${rotation}/${screen}/dumpsys-window-displays.txt`,
  )
}

describe.each(API_LEVELS)('rotateAndroid, on API %i', (level) => {
  it('locks the rotation, and reads the screen until it has turned', async () => {
    const { calls, target } = emulator(level, {
      [`${ADB} wm user-rotation lock 1`]: recorded(
        `api-${level}/none/rotation-1/user-rotation-lock.txt`,
      ),
      [AUTO_ROTATE_OFF]: {},
      [`${ADB} settings put system user_rotation 1`]: {},
      [DUMP]: [
        dump(level, 0, 'settings'),
        dump(level, 0, 'settings'),
        dump(level, 1, 'settings'),
      ],
    })

    const display = await rotateAndroid(await target(), 'landscape-left', {
      timeout: 1000,
      interval: 0,
    })

    expect(display).toEqual({
      orientation: 'landscape-left',
      size: { width: 2400 / 2.625, height: 1080 / 2.625 },
      pixels: { width: 2400, height: 1080 },
      scale: 2.625,
    })
    const writes = calls.filter((call) => call.args.includes('put'))
    expect(writes.map((call) => call.args.slice(-2))).toEqual(
      level === 30
        ? [
            ['accelerometer_rotation', '0'],
            ['user_rotation', '1'],
          ]
        : [],
    )
    expect(calls.filter((call) => call.args.includes('dumpsys'))).toHaveLength(
      3,
    )
  })

  // The launcher asks for NOSENSOR and shows portrait. On Android 14 and
  // later, a rotation written now is put back when the launcher leaves.
  it('writes nothing while the launcher is in front, even for portrait', async () => {
    const { calls, target } = emulator(level, {
      [DUMP]: dump(level, 1, 'home'),
    })

    await expect(
      rotateAndroid(await target(), 'portrait', { timeout: 0 }),
    ).rejects.toMatchObject({ code: 'orientation_locked' })
    expect(
      calls.some(
        (call) => call.args.includes('wm') || call.args.includes('put'),
      ),
    ).toBe(false)
  })
})

describe('rotateAndroid', () => {
  it.each([
    ['landscape-right', 3, 2400, 1080],
    ['portrait', 0, 1080, 2400],
  ] as const)('turns to %s', async (orientation, rotation, width, height) => {
    const { target } = emulator(36, {
      [`${ADB} wm user-rotation lock ${rotation}`]: {},
      [DUMP]: dump(36, rotation, 'settings'),
    })

    expect(
      await rotateAndroid(await target(), orientation, { timeout: 0 }),
    ).toMatchObject({ orientation, pixels: { width, height } })
  })

  it('fails with orientation_locked when the app in front sets its own orientation', async () => {
    const { calls, target } = emulator(36, {
      [DUMP]: dump(36, 1, 'home'),
    })

    await expect(
      rotateAndroid(await target(), 'landscape-left', { timeout: 0 }),
    ).rejects.toMatchObject({
      code: 'orientation_locked',
      message:
        "The app in front sets its own orientation (SCREEN_ORIENTATION_NOSENSOR), so loupe doesn't rotate now. The screen can't turn, and Android can undo the setting later. Open an app that follows the rotation, then rotate again.",
    })
    expect(calls.some((call) => call.args.includes('wm'))).toBe(false)
  })

  it('fails with orientation_locked when such an app comes to the front during the wait', async () => {
    const { calls, target } = emulator(36, {
      [`${ADB} wm user-rotation lock 1`]: {},
      [DUMP]: [dump(36, 0, 'settings'), dump(36, 1, 'home')],
    })

    await expect(
      rotateAndroid(await target(), 'landscape-left', {
        timeout: 1000,
        interval: 0,
      }),
    ).rejects.toMatchObject({ code: 'orientation_locked' })
    expect(calls.some((call) => call.args.includes('wm'))).toBe(true)
  })

  it('fails with timeout when the screen does not turn in time', async () => {
    const { target } = emulator(36, {
      [`${ADB} wm user-rotation lock 1`]: {},
      [DUMP]: dump(36, 0, 'settings'),
    })

    await expect(
      rotateAndroid(await target(), 'landscape-left', { timeout: 0 }),
    ).rejects.toMatchObject({
      code: 'timeout',
      message:
        "The screen didn't turn to landscape-left in 0 ms. It's portrait.",
    })
  })

  // Seen in CI on API 30: `mRotation` turns first, and `cur=` keeps the old
  // size for a moment. No recording caught that moment, so this changes the
  // size of a recorded landscape dump back to portrait.
  const stale: FakeRun = {
    stdout: recordedText(
      'api-30/none/rotation-1/settings/dumpsys-window-displays.txt',
    ).replace('cur=2400x1080', 'cur=1080x2400'),
  }

  it('waits until the size has turned with the rotation', async () => {
    const { calls, target } = emulator(30, {
      [`${ADB} wm user-rotation lock 1`]: recorded(
        'api-30/none/rotation-1/user-rotation-lock.txt',
      ),
      [AUTO_ROTATE_OFF]: {},
      [`${ADB} settings put system user_rotation 1`]: {},
      [DUMP]: [dump(30, 0, 'settings'), stale, dump(30, 1, 'settings')],
    })

    expect(
      await rotateAndroid(await target(), 'landscape-left', {
        timeout: 1000,
        interval: 0,
      }),
    ).toMatchObject({
      orientation: 'landscape-left',
      pixels: { width: 2400, height: 1080 },
    })
    expect(calls.filter((call) => call.args.includes('dumpsys'))).toHaveLength(
      3,
    )
  })

  it('fails with timeout when the size does not follow in time', async () => {
    const { target } = emulator(30, {
      [`${ADB} wm user-rotation lock 1`]: recorded(
        'api-30/none/rotation-1/user-rotation-lock.txt',
      ),
      [AUTO_ROTATE_OFF]: {},
      [`${ADB} settings put system user_rotation 1`]: {},
      [DUMP]: [dump(30, 0, 'settings'), stale],
    })

    await expect(
      rotateAndroid(await target(), 'landscape-left', { timeout: 0 }),
    ).rejects.toMatchObject({
      code: 'timeout',
      message:
        "The screen turned to landscape-left, but its size didn't follow in 0 ms: it's 1080 × 2400 px.",
    })
  })

  it('keeps a wm failure that is not an unknown command', async () => {
    const { calls, target } = emulator(36, {
      [`${ADB} wm user-rotation lock 1`]: { code: 1, stderr: 'error: closed' },
      [DUMP]: dump(36, 0, 'settings'),
    })

    await expect(
      rotateAndroid(await target(), 'landscape-left', { timeout: 0 }),
    ).rejects.toMatchObject({
      code: 'tool_failed',
      message: 'adb exited with code 1: error: closed',
    })
    expect(calls.some((call) => call.args.includes('put'))).toBe(false)
  })
})

describe('readAndroidDisplay', () => {
  it('gives the display in dp and px', async () => {
    const { target } = emulator(30, { [DUMP]: dump(30, 1, 'settings') })

    expect(await readAndroidDisplay(await target())).toEqual({
      orientation: 'landscape-left',
      size: { width: 2400 / 2.625, height: 1080 / 2.625 },
      pixels: { width: 2400, height: 1080 },
      scale: 2.625,
    })
  })

  it('fails when the dump has no display', async () => {
    const { target } = emulator(36, {
      [DUMP]: {
        stdout: 'WINDOW MANAGER DISPLAY CONTENTS (dumpsys window displays)\n',
      },
    })

    await expect(readAndroidDisplay(await target())).rejects.toMatchObject({
      code: 'tool_failed',
      message:
        'loupe can\'t read the display of emulator-5554 from "dumpsys window displays".',
    })
  })
})
