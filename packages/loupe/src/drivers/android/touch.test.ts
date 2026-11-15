import { describe, expect, it } from 'vitest'
import { DEFAULT_TIMEOUT_MS } from '../../core/exec'
import {
  byCommand,
  type FakeCall,
  type FakeRun,
  fakeContext,
} from '../../testing/fake-exec'
import { recorded } from '../../testing/fixtures'
import { selectAndroidDevice } from './devices'
import { holdAndroid, swipeAndroid, tapAndroid } from './touch'

const ADB = 'adb -s emulator-5554'

/** Settings in front. At rotation 1: landscape-left, 2400 × 1080 px. */
function emulator(
  runs: Readonly<Record<string, FakeRun>> = {},
  { level = 36, rotation = 1 } = {},
) {
  const api = `api-${level}`
  const { context, calls } = fakeContext(
    byCommand({
      'adb devices -l': recorded(`${api}/host/adb-devices-l.txt`),
      [`${ADB} shell getprop`]: recorded(`${api}/device/getprop.txt`),
      [`${ADB} shell dumpsys window displays`]: recorded(
        `${api}/none/rotation-${rotation}/settings/dumpsys-window-displays.txt`,
      ),
      ...runs,
    }),
  )
  return { calls, target: () => selectAndroidDevice(context) }
}

function inputs(calls: readonly FakeCall[]): string[] {
  return calls
    .filter((call) => call.args.includes('input'))
    .map((call) => call.args.slice(call.args.indexOf('input')).join(' '))
}

describe('tapAndroid', () => {
  it('taps in px of the current orientation', async () => {
    const { calls, target } = emulator({
      [`${ADB} shell input tap 263 525`]: {},
    })

    expect(await tapAndroid(await target(), { x: 100, y: 200 })).toEqual({
      orientation: 'landscape-left',
      points: [{ x: 100, y: 200 }],
      pixels: [{ x: 263, y: 525 }],
    })
    expect(inputs(calls)).toEqual(['input tap 263 525'])
  })

  it('uses the size of the screen in portrait', async () => {
    const { calls, target } = emulator(
      { [`${ADB} shell input tap 263 2100`]: {} },
      { level: 30, rotation: 0 },
    )

    await tapAndroid(await target(), { x: 100, y: 800 })

    expect(inputs(calls)).toEqual(['input tap 263 2100'])
  })

  it('keeps a point near the edge on the last px', async () => {
    const { calls, target } = emulator({
      [`${ADB} shell input tap 2399 1079`]: {},
    })

    await tapAndroid(await target(), { x: 914.28, y: 411.42 })

    expect(inputs(calls)).toEqual(['input tap 2399 1079'])
  })

  it.each([
    [100, 800],
    [914.2858, 0],
    [2400, 1080],
  ])('refuses (%d, %d), which is off the screen', async (x, y) => {
    const { calls, target } = emulator()

    await expect(tapAndroid(await target(), { x, y })).rejects.toMatchObject({
      code: 'invalid_input',
      message: `(${x}, ${y}) is off the screen, which is 914.29 × 411.43 dp in landscape-left. Points are in dp, not px.`,
    })
    expect(inputs(calls)).toEqual([])
  })

  it('checks the app before the tap, and not after it', async () => {
    const { calls, target } = emulator({
      [`${ADB} shell input tap 263 525`]: {},
    })

    await tapAndroid(await target(), { x: 100, y: 200 }, 'com.android.settings')

    expect(calls.filter((call) => call.args.includes('dumpsys'))).toHaveLength(
      1,
    )
  })

  it('touches nothing while another app is in front', async () => {
    const { calls, target } = emulator()

    await expect(
      tapAndroid(await target(), { x: 100, y: 200 }, 'com.example.app'),
    ).rejects.toMatchObject({ code: 'app_not_in_front' })
    expect(inputs(calls)).toEqual([])
  })

  it('needs the app on a real device', async () => {
    const { context, calls } = fakeContext(
      byCommand({
        'adb devices -l': {
          stdout:
            'List of devices attached\nPHONE123               device product:phone model:Phone_Model device:phone transport_id:4\n\n',
        },
        'adb -s PHONE123 shell getprop': {
          stdout: '[ro.build.version.sdk]: [35]\n[sys.boot_completed]: [1]\n',
        },
      }),
    )

    await expect(
      tapAndroid(await selectAndroidDevice(context), { x: 100, y: 200 }),
    ).rejects.toMatchObject({ code: 'invalid_input' })
    expect(inputs(calls)).toEqual([])
  })

  it('keeps an input failure', async () => {
    const { target } = emulator({
      [`${ADB} shell input tap 263 525`]: { code: 1, stderr: 'Error' },
    })

    await expect(
      tapAndroid(await target(), { x: 100, y: 200 }),
    ).rejects.toMatchObject({ code: 'tool_failed' })
  })
})

describe('holdAndroid', () => {
  it('sends a swipe that does not move, and waits for it', async () => {
    const { calls, target } = emulator({
      [`${ADB} shell input swipe 263 525 263 525 60000`]: {},
    })

    expect(
      await holdAndroid(await target(), { x: 100, y: 200 }, 60000),
    ).toMatchObject({ pixels: [{ x: 263, y: 525 }], duration: 60000 })
    expect(calls.at(-1)?.options?.timeout).toBe(60000 + DEFAULT_TIMEOUT_MS)
  })
})

describe('swipeAndroid', () => {
  it('sends both points in px, and the duration', async () => {
    const { calls, target } = emulator({
      [`${ADB} shell input swipe 263 525 788 525 300`]: {},
    })

    expect(
      await swipeAndroid(
        await target(),
        { x: 100, y: 200 },
        { x: 300, y: 200 },
        300,
      ),
    ).toEqual({
      orientation: 'landscape-left',
      points: [
        { x: 100, y: 200 },
        { x: 300, y: 200 },
      ],
      pixels: [
        { x: 263, y: 525 },
        { x: 788, y: 525 },
      ],
      duration: 300,
    })
    expect(inputs(calls)).toEqual(['input swipe 263 525 788 525 300'])
  })

  it('refuses an end point off the screen, and touches nothing', async () => {
    const { calls, target } = emulator()

    await expect(
      swipeAndroid(await target(), { x: 100, y: 200 }, { x: 100, y: 500 }, 300),
    ).rejects.toMatchObject({ code: 'invalid_input' })
    expect(inputs(calls)).toEqual([])
  })
})
