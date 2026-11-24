import { describe, expect, it } from 'vitest'
import { runCommand } from '../core/run-command'
import {
  byCommand,
  type FakeCall,
  type FakeRun,
  fakeContext,
} from '../testing/fake-exec'
import { fakeFetch } from '../testing/fake-fetch'
import { recorded, recordedText } from '../testing/fixtures'
import { metroRoutes } from '../testing/metro'
import { pngHeader } from '../testing/png'
import { registry } from './index'

const ADB = 'adb -s emulator-5554'
const DISPLAYS = 'sheets/alert/back/before.dumpsys-window-displays.txt'
const EXPERIENCE =
  'host.exp.exponent/host.exp.exponent.experience.ExperienceActivity'

/** Round 10's dump of one Expo Go screen, with `change` on its text. */
function dump(
  level: 30 | 36,
  file: string,
  change: (text: string) => string = (text) => text,
): FakeRun {
  return { stdout: change(recordedText(`api-${level}/expo/${file}`)) }
}

/** A display dump with this window in focus. */
function focusOn(level: 30 | 36, title: string): FakeRun {
  return {
    stdout: recordedText(`api-${level}/${DISPLAYS}`).replace(EXPERIENCE, title),
  }
}

/**
 * An emulator with Expo Go, and the probe app's Metro. Each `am start`
 * and each `input` call succeeds.
 */
function emulator(
  level: 30 | 36,
  dumps: readonly FakeRun[],
  runs: Readonly<Record<string, FakeRun | readonly FakeRun[]>> = {},
) {
  const table = byCommand({
    'adb devices -l': recorded(`api-${level}/host/adb-devices-l.txt`),
    [`${ADB} shell getprop`]: recorded(`api-${level}/device/getprop.txt`),
    [`${ADB} shell pm path host.exp.exponent`]: recorded(
      `api-${level}/expo/expo-go/pm-path.txt`,
    ),
    [`${ADB} shell dumpsys package host.exp.exponent`]: recorded(
      `api-${level}/expo/expo-go/dumpsys-package.txt`,
    ),
    [`${ADB} reverse tcp:8081 tcp:8081`]: recorded(
      `api-${level}/expo/open/reverse.txt`,
    ),
    [`${ADB} shell dumpsys window displays`]: recorded(
      `api-${level}/${DISPLAYS}`,
    ),
    [`${ADB} exec-out uiautomator dump /dev/tty`]: dumps,
    [`${ADB} exec-out screencap -p`]: { stdout: pngHeader(1080, 2400) },
    ...runs,
  })
  const { context, calls } = fakeContext((call) => {
    if (call.args.includes('am')) {
      return recorded('api-36/extra/am-start-https.txt')
    }
    if (call.args.includes('input')) return {}
    return table(call)
  })
  const { fetch, requests } = fakeFetch(metroRoutes())
  return { context: { ...context, fetch }, calls, requests }
}

const opensOf = (calls: readonly FakeCall[]) =>
  calls.filter((call) => call.args.includes('am'))
const tapsOf = (calls: readonly FakeCall[]) =>
  calls.filter((call) => call.args.includes('input'))

describe('expo-open', () => {
  it.each([30, 36] as const)(
    'closes the onboarding sheet and the menu of the first open (API %i)',
    async (level) => {
      const { context, calls, requests } = emulator(level, [
        dump(level, 'open/onboarding.ui-tty.txt'),
        dump(level, 'open/dev-menu.ui-tty.txt'),
        dump(level, 'open/shown.ui-tty.txt'),
      ])

      const result = await runCommand(
        registry,
        'expo-open',
        { route: 'appstate' },
        context,
      )

      expect(result).toMatchObject({
        ok: true,
        data: {
          link: 'exp://127.0.0.1:8081/--/appstate',
          app: { name: 'Probe app', sdkVersion: '58.0.0' },
          expoGo: '58.0.6',
          opens: 1,
          closed: ['onboarding', 'dev-menu'],
          route: '/appstate',
          probe: true,
          warnings: [],
        },
      })
      expect(tapsOf(calls)).toHaveLength(2)
      expect(opensOf(calls)[0]?.args.slice(-3)).toEqual([
        "'exp://127.0.0.1:8081/--/appstate'",
        '-p',
        'host.exp.exponent',
      ])
      expect(
        calls.some((call) =>
          call.args.join(' ').endsWith('reverse tcp:8081 tcp:8081'),
        ),
      ).toBe(true)
      expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
        '/status',
        '/',
        '/apps/probe-app/index.ts.bundle',
      ])
    },
  )

  it("waits through Expo Go's loading screen", async () => {
    const { context } = emulator(30, [
      dump(30, 'rtl/menu-key-ltr/after.ui-tty.txt'),
      dump(30, 'open/shown.ui-tty.txt'),
    ])

    const result = await runCommand(
      registry,
      'expo-open',
      { route: '/appstate' },
      context,
    )

    expect(result).toMatchObject({ ok: true, data: { closed: [] } })
  })

  it('waits until the probe shows the route', async () => {
    const { context, calls } = emulator(36, [
      dump(36, 'open/shown.ui-tty.txt', (text) =>
        text.replace('"route":"/appstate"', '"route":"/"'),
      ),
      dump(36, 'open/shown.ui-tty.txt'),
    ])

    const result = await runCommand(
      registry,
      'expo-open',
      { route: '/appstate/' },
      context,
    )

    expect(result).toMatchObject({ ok: true, data: { route: '/appstate' } })
    expect(
      calls.filter((call) => call.args.includes('uiautomator')),
    ).toHaveLength(2)
  })

  it('waits for a still screen when the app has no probe', async () => {
    const { context, calls } = emulator(36, [
      dump(36, 'open/shown.ui-tty.txt', (text) =>
        text.replace(/content-desc='loupe:[^']*'/, 'content-desc=""'),
      ),
    ])

    const result = await runCommand(registry, 'expo-open', {}, context)

    expect(result).toMatchObject({
      ok: true,
      data: { link: 'exp://127.0.0.1:8081', probe: false },
    })
    expect(JSON.parse(JSON.stringify(result))).not.toHaveProperty('data.route')
    expect(
      calls.filter((call) => call.args.includes('screencap')).length,
    ).toBeGreaterThanOrEqual(2)
  })

  it("warns when Expo Go isn't for the SDK of the app", async () => {
    const { context } = emulator(36, [dump(36, 'open/shown.ui-tty.txt')], {
      [`${ADB} shell dumpsys package host.exp.exponent`]: {
        stdout: recordedText('api-36/expo/expo-go/dumpsys-package.txt').replace(
          'versionName=58.0.6',
          'versionName=57.0.2',
        ),
      },
    })

    const result = await runCommand(registry, 'expo-open', {}, context)

    expect(result).toMatchObject({
      ok: true,
      data: {
        expoGo: '57.0.2',
        warnings: [expect.stringContaining('the Expo Go of SDK 58')],
      },
    })
  })

  it('gives no_handler with no Expo Go, and asks Metro nothing', async () => {
    const { context, requests } = emulator(36, [], {
      [`${ADB} shell pm path host.exp.exponent`]: recorded(
        'api-36/expo/expo-go/pm-path-before.txt',
      ),
    })

    const result = await runCommand(registry, 'expo-open', {}, context)

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'no_handler',
        message: expect.stringContaining('npx expo start'),
      },
    })
    expect(requests).toEqual([])
  })

  it('points to loupe dismiss when a dialog of another app is in front', async () => {
    const { context } = emulator(36, [], {
      [`${ADB} shell dumpsys window displays`]: focusOn(
        36,
        'Application Not Responding: com.google.android.apps.nexuslauncher',
      ),
    })

    const result = await runCommand(registry, 'expo-open', {}, context)

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'app_not_in_front',
        message: expect.stringContaining('loupe dismiss'),
      },
    })
  })

  it('says what showed last when the app never shows', async () => {
    const { context } = emulator(30, [
      dump(30, 'rtl/menu-key-ltr/after.ui-tty.txt'),
    ])

    const result = await runCommand(
      registry,
      'expo-open',
      { timeout: 1000 },
      context,
    )

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'timeout',
        message:
          "Expo Go didn't show the app in 1 s after loupe opened exp://127.0.0.1:8081 (once). The last read: Expo Go's loading screen.",
      },
    })
  })
})
