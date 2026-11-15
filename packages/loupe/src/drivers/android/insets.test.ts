import { describe, expect, it } from 'vitest'
import { NO_INSETS } from '../../core/insets'
import { byCommand, type FakeRun, fakeContext } from '../../testing/fake-exec'
import { API_LEVELS, recorded, recordedText } from '../../testing/fixtures'
import { selectAndroidDevice } from './devices'
import { insetOf, readAndroidInsets } from './insets'

const ADB = 'adb -s emulator-5554'
const SCALE = 2.625

function emulator(level: number, dump: FakeRun) {
  const api = `api-${level}`
  const { context } = fakeContext(
    byCommand({
      'adb devices -l': recorded(`${api}/host/adb-devices-l.txt`),
      [`${ADB} shell getprop`]: recorded(`${api}/device/getprop.txt`),
      [`${ADB} shell dumpsys window displays`]: dump,
    }),
  )
  return () => selectAndroidDevice(context)
}

async function insetsOf(level: number, path: string) {
  const target = emulator(
    level,
    recorded(`api-${level}/${path}/dumpsys-window-displays.txt`),
  )
  return readAndroidInsets(await target())
}

/** Insets in px, as dp. */
function dp(top: number, right: number, bottom: number, left: number) {
  return {
    top: top / SCALE,
    right: right / SCALE,
    bottom: bottom / SCALE,
    left: left / SCALE,
  }
}

describe.each(API_LEVELS)('readAndroidInsets, on API %i', (level) => {
  // API 30 has the 3-button navigation bar at the side in landscape; the
  // later images have the gesture bar at the bottom.
  it('keeps a one-sided cutout on its side in landscape-left', async () => {
    const reading = await insetsOf(level, 'hole/rotation-1/settings')

    expect(reading).toMatchObject({
      orientation: 'landscape-left',
      source: 'dumpsys',
      cutout: dp(0, 0, 0, 136),
      cutoutRects: [
        { x: 0, y: 944 / SCALE, width: 136 / SCALE, height: 136 / SCALE },
      ],
      warnings: [],
    })
    expect(reading.systemBars).toEqual(
      level === 30 ? dp(74, 126, 0, 0) : dp(63, 0, 63, 0),
    )
    expect(reading.safeArea).toEqual(
      level === 30 ? dp(74, 126, 0, 136) : dp(63, 0, 63, 136),
    )
  })
})

describe('readAndroidInsets', () => {
  it.each([
    [30, dp(74, 136, 0, 126)],
    [36, dp(63, 136, 63, 0)],
  ])(
    'puts the cutout on the right in landscape-right, on API %i',
    async (level, safeArea) => {
      const reading = await insetsOf(level, 'hole/rotation-3/settings')

      expect(reading.orientation).toBe('landscape-right')
      expect(reading.cutout).toEqual(dp(0, 136, 0, 0))
      expect(reading.safeArea).toEqual(safeArea)
    },
  )

  it.each([
    [30, dp(126, 0, 126, 0)],
    [36, dp(126, 0, 63, 0)],
  ])(
    'gives the corner cutout at the top in portrait, on API %i',
    async (level, safeArea) => {
      const reading = await insetsOf(level, 'corner/rotation-0/settings')

      expect(reading.cutout).toEqual(dp(126, 0, 0, 0))
      expect(reading.cutoutRects).toEqual([
        { x: 954 / SCALE, y: 0, width: 126 / SCALE, height: 126 / SCALE },
      ])
      expect(reading.safeArea).toEqual(safeArea)
    },
  )

  it('gives no cutout on API 30 with no overlay', async () => {
    const reading = await insetsOf(30, 'none/rotation-1/settings')

    expect(reading.cutout).toEqual(NO_INSETS)
    expect(reading.cutoutRects).toEqual([])
  })

  it("reads the device profile's own cutout on API 36", async () => {
    const reading = await insetsOf(36, 'none/rotation-0/settings')

    expect(reading.cutout).toEqual(dp(128, 0, 0, 0))
    expect(reading.cutoutRects).toEqual([
      { x: 492 / SCALE, y: 0, width: 118 / SCALE, height: 128 / SCALE },
    ])
  })

  // No recording has Expo Go in front, so the focus line of a recorded dump
  // is changed to Expo Go's here.
  function withExpoGo(level: number): FakeRun {
    const dump = recordedText(
      `api-${level}/hole/rotation-1/settings/dumpsys-window-displays.txt`,
    )
    return {
      stdout: dump.replace(
        /mCurrentFocus=Window\{(\S+) u0 [^}]+\}/,
        'mCurrentFocus=Window{$1 u0 host.exp.exponent/host.exp.exponent.experience.ExperienceActivity}',
      ),
    }
  }

  it.each([
    [34, 1],
    [35, 0],
  ])(
    'warns about the Expo Go letterbox on API %i: %i warning',
    async (level, count) => {
      const target = emulator(level, withExpoGo(level))

      const reading = await readAndroidInsets(await target())

      expect(reading.warnings).toHaveLength(count)
    },
  )

  it('fails on a dump with no display', async () => {
    const target = emulator(36, { stdout: 'nothing\n' })

    await expect(readAndroidInsets(await target())).rejects.toMatchObject({
      code: 'tool_failed',
    })
  })
})

describe('insetOf', () => {
  const screen = { width: 2400, height: 1080 }
  const source = (
    x: number,
    y: number,
    width: number,
    height: number,
    sideHint?: string,
  ) => ({
    type: 'statusBars',
    frame: { x, y, width, height },
    visible: true,
    sideHint,
  })

  it.each([
    ['a bar along the top', source(0, 0, 2400, 63), { top: 63 }],
    ['a bar along the bottom', source(0, 1017, 2400, 63), { bottom: 63 }],
    ['a bar along the left', source(0, 0, 126, 1080), { left: 126 }],
    ['a bar along the right', source(2274, 0, 126, 1080), { right: 126 }],
    [
      'part of the top, with a hint',
      source(100, 0, 200, 50, 'TOP'),
      { top: 50 },
    ],
    [
      'part of the right, with a hint',
      source(2300, 10, 50, 50, 'RIGHT'),
      { right: 100 },
    ],
    ['part of an edge, with no hint', source(100, 0, 200, 50), {}],
    ['an upside-down frame', source(0, 0, 2400, -2147483648), {}],
    ['the whole screen', source(0, 0, 2400, 1080), {}],
  ])('gives %s', (_name, input, inset) => {
    expect(insetOf(input, screen)).toEqual({ ...NO_INSETS, ...inset })
  })
})
