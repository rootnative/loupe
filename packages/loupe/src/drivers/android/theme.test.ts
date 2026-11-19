import { describe, expect, it } from 'vitest'
import { byCommand, type FakeRun, fakeContext } from '../../testing/fake-exec'
import { API_LEVELS, recorded, recordedText } from '../../testing/fixtures'
import { selectAndroidDevice } from './devices'
import { readThemeAndroid, setThemeAndroid } from './theme'

const EXPO_GO = 'host.exp.exponent'
const WAIT = { timeout: 5000, interval: 0 }
const NO_WAIT = { timeout: 0, interval: 0 }

/** Round 5: the probe app in portrait, in each theme. */
function probeDump(level: number, theme: 'light' | 'dark'): FakeRun {
  return recorded(
    `api-${level}/probe/night/${theme === 'dark' ? '' : 'light/'}last.ui-tty.txt`,
  )
}

interface Runs {
  /** The answer to `cmd uimode night` with no value. */
  night: FakeRun
  /** The answer to `cmd uimode night yes`. Default: round 5's. */
  yes?: FakeRun
  dumps?: readonly FakeRun[]
}

function emulator(
  level: number,
  { night, yes, dumps = [probeDump(level, 'dark')] }: Runs,
  serial = 'emulator-5554',
) {
  const phone = !serial.startsWith('emulator-')
  const adb = `adb -s ${serial}`
  const probe = `api-${level}/probe`
  const { context, calls } = fakeContext(
    byCommand({
      'adb devices -l': phone
        ? {
            stdout: `List of devices attached\n${serial}               device product:phone model:Phone_Model device:phone transport_id:4\n\n`,
          }
        : recorded(`api-${level}/host/adb-devices-l.txt`),
      [`${adb} shell getprop`]: phone
        ? {
            stdout: `[ro.build.version.sdk]: [${level}]\n[sys.boot_completed]: [1]\n`,
          }
        : recorded(`api-${level}/device/getprop.txt`),
      // Expo Go in front, in portrait (round 8).
      [`${adb} shell dumpsys window displays`]: recorded(
        `api-${level}/sheets/alert/back/before.dumpsys-window-displays.txt`,
      ),
      [`${adb} shell cmd uimode night`]: night,
      [`${adb} shell cmd uimode night yes`]:
        yes ?? recorded(`${probe}/night/uimode-yes.txt`),
      [`${adb} shell cmd uimode night no`]: recorded(
        `${probe}/night/uimode-no.txt`,
      ),
      [`${adb} exec-out uiautomator dump /dev/tty`]: dumps,
    }),
  )
  const writes = () =>
    calls
      .map((call) => call.args.slice(3).join(' '))
      .filter((args) => /^cmd uimode night \w/.test(args))
  return { target: () => selectAndroidDevice(context), writes }
}

describe.each(API_LEVELS)('the theme, on API %i', (level) => {
  const atStart = recorded(
    `api-${level}/probe/device/uimode-night-at-start.txt`,
  )
  const dark = recorded(`api-${level}/probe/night/uimode-yes.txt`)

  it('reads the setting', async () => {
    const { target, writes } = emulator(level, { night: atStart })

    expect(await readThemeAndroid(await target())).toBe('light')
    expect(writes()).toEqual([])
  })

  it('sets dark, and waits until the probe shows it', async () => {
    const { target, writes } = emulator(level, {
      night: atStart,
      dumps: [probeDump(level, 'light'), probeDump(level, 'dark')],
    })

    expect(
      await setThemeAndroid(await target(), 'dark', EXPO_GO, WAIT),
    ).toEqual({
      theme: 'dark',
      was: 'light',
      source: 'probe',
      ms: expect.any(Number),
      warnings: [],
    })
    expect(writes()).toEqual(['cmd uimode night yes'])
  })

  it('sets light again', async () => {
    const { target, writes } = emulator(level, {
      night: dark,
      dumps: [probeDump(level, 'light')],
    })

    expect(
      await setThemeAndroid(await target(), 'light', EXPO_GO, WAIT),
    ).toMatchObject({ theme: 'light', was: 'dark', source: 'probe' })
    expect(writes()).toEqual(['cmd uimode night no'])
  })
})

describe('setThemeAndroid', () => {
  const atStart = recorded('api-36/probe/device/uimode-night-at-start.txt')

  it('writes nothing when the theme is set already', async () => {
    const { target, writes } = emulator(36, {
      night: recorded('api-36/probe/night/uimode-yes.txt'),
    })

    expect(
      await setThemeAndroid(await target(), 'dark', EXPO_GO, WAIT),
    ).toMatchObject({ was: 'dark', source: 'probe' })
    expect(writes()).toEqual([])
  })

  it('warns when the probe keeps the other scheme', async () => {
    const { target } = emulator(36, {
      night: atStart,
      dumps: [probeDump(36, 'light')],
    })

    expect(
      await setThemeAndroid(await target(), 'dark', EXPO_GO, NO_WAIT),
    ).toMatchObject({
      source: 'setting',
      warnings: [
        'The setting is dark, but the probe still shows light after 0 ms. The app can keep one theme (for example userInterfaceStyle in Expo), or it is slow.',
      ],
    })
  })

  it('takes the setting alone on a screen with no probe', async () => {
    const dump = recordedText('api-36/probe/night/light/last.ui-tty.txt')
    const { target } = emulator(36, {
      night: atStart,
      dumps: [
        { stdout: dump.replace("content-desc='loupe:", "content-desc='") },
      ],
    })

    expect(
      await setThemeAndroid(await target(), 'dark', EXPO_GO, WAIT),
    ).toMatchObject({ source: 'setting', warnings: [] })
  })

  it('reads past a screen that is busy for a moment', async () => {
    const { target } = emulator(36, {
      night: atStart,
      dumps: [
        { stdout: 'ERROR: could not get idle state.\n' },
        probeDump(36, 'dark'),
      ],
    })

    expect(
      await setThemeAndroid(await target(), 'dark', EXPO_GO, WAIT),
    ).toMatchObject({ source: 'probe' })
  })

  it('gives the last error when the screen stays busy', async () => {
    const { target, writes } = emulator(36, {
      night: atStart,
      dumps: [{ stdout: 'ERROR: could not get idle state.\n' }],
    })

    await expect(
      setThemeAndroid(await target(), 'dark', EXPO_GO, NO_WAIT),
    ).rejects.toMatchObject({
      code: 'not_idle',
      message: expect.stringMatching(
        /^The theme is dark now, but loupe can't see the app show it\. The screen of emulator-5554 didn't keep still/,
      ),
    })
    expect(writes()).toEqual(['cmd uimode night yes'])
  })

  it('reads auto and custom, and sets a theme over them', async () => {
    const auto = emulator(36, { night: { stdout: 'Night mode: auto\n' } })
    const custom = emulator(36, { night: { stdout: 'Night mode: custom\n' } })

    expect(await readThemeAndroid(await custom.target())).toBe('custom')
    expect(
      await setThemeAndroid(await auto.target(), 'dark', EXPO_GO, WAIT),
    ).toMatchObject({ theme: 'dark', was: 'auto' })
    expect(auto.writes()).toEqual(['cmd uimode night yes'])
  })

  it('fails when it cannot read the setting, or Android keeps another', async () => {
    const unknown = emulator(36, { night: { stdout: 'Unknown command\n' } })
    const kept = emulator(36, {
      night: atStart,
      yes: recorded('api-36/probe/night/uimode-no.txt'),
    })

    await expect(
      readThemeAndroid(await unknown.target()),
    ).rejects.toMatchObject({
      code: 'tool_failed',
      message: `loupe can't read the night mode of emulator-5554 from "cmd uimode night".`,
    })
    await expect(
      setThemeAndroid(await kept.target(), 'dark', EXPO_GO, WAIT),
    ).rejects.toMatchObject({
      code: 'tool_failed',
      message: 'Android kept the theme light on emulator-5554, not dark.',
    })
  })

  it('needs the app on a phone, and writes nothing without it', async () => {
    const { target, writes } = emulator(36, { night: atStart }, 'PHONE123')

    await expect(
      setThemeAndroid(await target(), 'dark', undefined, WAIT),
    ).rejects.toMatchObject({ code: 'invalid_input' })
    expect(writes()).toEqual([])
  })
})
