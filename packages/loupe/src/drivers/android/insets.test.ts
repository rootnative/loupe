import { describe, expect, it } from 'vitest'
import { NO_INSETS } from '../../core/insets'
import { type Insets } from '../../core/units'
import { byCommand, type FakeRun, fakeContext } from '../../testing/fake-exec'
import { API_LEVELS, recorded, recordedText } from '../../testing/fixtures'
import { selectAndroidDevice } from './devices'
import {
  insetOf,
  insetsOfUi,
  readAndroidInsets,
  readSystemInsets,
} from './insets'
import { readAndroidUi } from './ui'

const ADB = 'adb -s emulator-5554'
const SCALE = 2.625

function emulator(
  level: number,
  displays: FakeRun | FakeRun[],
  dump?: FakeRun,
) {
  const api = `api-${level}`
  const { context, calls } = fakeContext(
    byCommand({
      'adb devices -l': recorded(`${api}/host/adb-devices-l.txt`),
      [`${ADB} shell getprop`]: recorded(`${api}/device/getprop.txt`),
      [`${ADB} shell dumpsys window displays`]: displays,
      ...(dump && { [`${ADB} exec-out uiautomator dump /dev/tty`]: dump }),
    }),
  )
  return { calls, target: () => selectAndroidDevice(context) }
}

async function systemInsetsOf(level: number, path: string) {
  const { target } = emulator(
    level,
    recorded(`api-${level}/${path}/dumpsys-window-displays.txt`),
  )
  return readSystemInsets(await target())
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

/** The probe gives float32 dp, so its numbers are close, not equal. */
function expectClose(insets: Insets, expected: Insets) {
  for (const edge of ['top', 'right', 'bottom', 'left'] as const) {
    expect(insets[edge]).toBeCloseTo(expected[edge], 5)
  }
}

function uiCalls(calls: readonly { args: string[] }[]): number {
  return calls.filter((call) => call.args.includes('uiautomator')).length
}

describe.each(API_LEVELS)('readSystemInsets, on API %i', (level) => {
  // API 30 has the 3-button navigation bar at the side in landscape; the
  // later images have the gesture bar at the bottom.
  it('keeps a one-sided cutout on its side in landscape-left', async () => {
    const reading = await systemInsetsOf(level, 'hole/rotation-1/settings')

    expect(reading).toMatchObject({
      orientation: 'landscape-left',
      cutout: dp(0, 0, 0, 136),
      cutoutRects: [
        { x: 0, y: 944 / SCALE, width: 136 / SCALE, height: 136 / SCALE },
      ],
    })
    expect(reading.systemBars).toEqual(
      level === 30 ? dp(74, 126, 0, 0) : dp(63, 0, 63, 0),
    )
    expect(reading.safeArea).toEqual(
      level === 30 ? dp(74, 126, 0, 136) : dp(63, 0, 63, 136),
    )
  })
})

describe('readSystemInsets', () => {
  it.each([
    [30, dp(74, 136, 0, 126)],
    [36, dp(63, 136, 63, 0)],
  ])(
    'puts the cutout on the right in landscape-right, on API %i',
    async (level, safeArea) => {
      const reading = await systemInsetsOf(level, 'hole/rotation-3/settings')

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
      const reading = await systemInsetsOf(level, 'corner/rotation-0/settings')

      expect(reading.cutout).toEqual(dp(126, 0, 0, 0))
      expect(reading.cutoutRects).toEqual([
        { x: 954 / SCALE, y: 0, width: 126 / SCALE, height: 126 / SCALE },
      ])
      expect(reading.safeArea).toEqual(safeArea)
    },
  )

  it('gives no cutout on API 30 with no overlay', async () => {
    const reading = await systemInsetsOf(30, 'none/rotation-1/settings')

    expect(reading.cutout).toEqual(NO_INSETS)
    expect(reading.cutoutRects).toEqual([])
  })

  it("reads the device profile's own cutout on API 36", async () => {
    const reading = await systemInsetsOf(36, 'none/rotation-0/settings')

    expect(reading.cutout).toEqual(dp(128, 0, 0, 0))
    expect(reading.cutoutRects).toEqual([
      { x: 492 / SCALE, y: 0, width: 118 / SCALE, height: 128 / SCALE },
    ])
  })

  it('fails on a dump with no display', async () => {
    const { target } = emulator(36, { stdout: 'nothing\n' })

    await expect(readSystemInsets(await target())).rejects.toMatchObject({
      code: 'tool_failed',
    })
  })
})

/** The probe app in Expo Go, from the probe recorder (round 5). */
function probeApp(level: number, step: string, dump?: FakeRun) {
  const path = `api-${level}/probe/${step}`
  return emulator(
    level,
    recorded(`${path}/dumpsys-window-displays.txt`),
    dump ?? recorded(`${path}/last.ui-tty.txt`),
  )
}

/** The dump of the probe app, with the label changed by `change`. */
function changedLabel(
  level: number,
  step: string,
  change: (label: string) => string,
): FakeRun {
  const dump = recordedText(`api-${level}/probe/${step}/last.ui-tty.txt`)
  return {
    stdout: dump.replace(/content-desc='loupe:[^']*'/, (label) =>
      change(label),
    ),
  }
}

// In round 5, the probe and dumpsys agree in each rotation and cutout on
// each level.
describe.each(API_LEVELS)(
  'readAndroidInsets of the probe app, on API %i',
  (level) => {
    it("gives the probe's safe area, the same as the system's", async () => {
      const { calls, target } = probeApp(level, 'hole/rotation-1')

      const reading = await readAndroidInsets(await target())

      expect(reading).toMatchObject({
        orientation: 'landscape-left',
        source: 'probe',
        cutout: dp(0, 0, 0, 136),
        warnings: [],
      })
      expectClose(
        reading.safeArea,
        level === 30 ? dp(74, 126, 0, 136) : dp(63, 0, 63, 136),
      )
      expect(uiCalls(calls)).toBe(1)
    })
  },
)

describe('readAndroidInsets', () => {
  it.each([
    [30, 'hole/rotation-3', 'landscape-right', dp(74, 136, 0, 126)],
    [36, 'hole/rotation-3', 'landscape-right', dp(63, 136, 63, 0)],
    [30, 'none/rotation-0', 'portrait', dp(63, 0, 126, 0)],
    [36, 'none/rotation-0', 'portrait', dp(128, 0, 63, 0)],
  ])(
    'reads the probe on API %i, %s',
    async (level, step, orientation, safeArea) => {
      const { target } = probeApp(level, step)

      const reading = await readAndroidInsets(await target())

      expect(reading).toMatchObject({
        orientation,
        source: 'probe',
        warnings: [],
      })
      expectClose(reading.safeArea, safeArea)
    },
  )

  it("gives the system's safe area for a screen with no probe", async () => {
    const { target } = probeApp(
      36,
      'none/rotation-0',
      recorded('api-36/probe/extra/ui-compressed.txt'),
    )

    const reading = await readAndroidInsets(await target())

    expect(reading).toMatchObject({
      source: 'dumpsys',
      safeArea: dp(128, 0, 63, 0),
      warnings: [],
    })
  })

  it('warns when the app and the system differ at an edge', async () => {
    const dump = changedLabel(36, 'hole/rotation-1', (label) =>
      label.replace(/"left":[\d.]+/, '"left":0'),
    )
    const { target } = probeApp(36, 'hole/rotation-1', dump)

    const reading = await readAndroidInsets(await target())

    expect(reading.source).toBe('probe')
    expect(reading.safeArea.left).toBe(0)
    expect(reading.warnings).toEqual([
      expect.stringContaining(
        "isn't the system's: left 0 dp in the app, 51.81 dp from the system.",
      ),
    ])
  })

  it.each([
    [
      'a probe with no SafeAreaProvider',
      (label: string) => label.replace(/"insets":\{[^}]*\},/, ''),
      'no SafeAreaProvider',
    ],
    [
      'a probe of a later format',
      (label: string) => label.replace('"v":1', '"v":2'),
      'format 2',
    ],
  ])(
    "gives the system's safe area for %s, with a warning",
    async (_name, change, words) => {
      const dump = changedLabel(36, 'hole/rotation-1', change)
      const { target } = probeApp(36, 'hole/rotation-1', dump)

      const reading = await readAndroidInsets(await target())

      expect(reading.source).toBe('dumpsys')
      expect(reading.safeArea).toEqual(dp(63, 0, 63, 136))
      expect(reading.warnings).toEqual([expect.stringContaining(words)])
    },
  )

  it("gives the system's safe area when the screen never keeps still", async () => {
    const { target } = probeApp(36, 'hole/rotation-1', {
      stdout: 'ERROR: could not get idle state.\n',
    })

    const reading = await readAndroidInsets(await target())

    expect(reading.source).toBe('dumpsys')
    expect(reading.warnings).toEqual([
      expect.stringContaining("didn't keep still"),
    ])
  })

  it('fails when the screen turned after the dump', async () => {
    const path = 'api-36/probe/hole'
    const { target } = emulator(
      36,
      [
        recorded(`${path}/rotation-1/dumpsys-window-displays.txt`),
        recorded(`${path}/rotation-3/dumpsys-window-displays.txt`),
      ],
      recorded(`${path}/rotation-1/last.ui-tty.txt`),
    )

    await expect(readAndroidInsets(await target())).rejects.toMatchObject({
      code: 'tool_failed',
      message: expect.stringContaining('turned'),
    })
  })

  it('reads the probe only while the app is in front', async () => {
    const { calls, target } = probeApp(36, 'hole/rotation-1')

    await expect(
      readAndroidInsets(await target(), 'com.example.app'),
    ).rejects.toMatchObject({ code: 'app_not_in_front' })
    expect(uiCalls(calls)).toBe(0)
  })

  /** A phone on API 35, with the recordings of the API 35 emulator. */
  function phone() {
    const adb = 'adb -s PHONE123'
    const path = 'api-35/probe/hole/rotation-1'
    const { context, calls } = fakeContext(
      byCommand({
        'adb devices -l': {
          stdout:
            'List of devices attached\nPHONE123               device product:phone model:Phone_Model device:phone transport_id:4\n\n',
        },
        [`${adb} shell getprop`]: {
          stdout: '[ro.build.version.sdk]: [35]\n[sys.boot_completed]: [1]\n',
        },
        [`${adb} shell dumpsys window displays`]: recorded(
          `${path}/dumpsys-window-displays.txt`,
        ),
        [`${adb} exec-out uiautomator dump /dev/tty`]: recorded(
          `${path}/last.ui-tty.txt`,
        ),
      }),
    )
    return { calls, target: () => selectAndroidDevice(context) }
  }

  it("doesn't read the screen of a real device with no app", async () => {
    const { calls, target } = phone()

    const reading = await readAndroidInsets(await target())

    expect(reading.source).toBe('dumpsys')
    expect(reading.warnings).toEqual([
      expect.stringContaining('only with the "app" option'),
    ])
    expect(uiCalls(calls)).toBe(0)
  })

  it('reads the probe on a real device with the app', async () => {
    const { target } = phone()

    const reading = await readAndroidInsets(await target(), 'host.exp.exponent')

    expect(reading).toMatchObject({ source: 'probe', warnings: [] })
  })
})

describe('insetsOfUi', () => {
  it('takes the probe from a screen that loupe read, with no second dump', async () => {
    const { calls, target } = probeApp(36, 'hole/rotation-1')
    const device = await target()

    const reading = await insetsOfUi(device, await readAndroidUi(device))

    expect(reading).toMatchObject({ source: 'probe', warnings: [] })
    expectClose(reading.safeArea, dp(63, 0, 63, 136))
    expect(uiCalls(calls)).toBe(1)
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
