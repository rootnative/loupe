import { describe, expect, it } from 'vitest'
import { runCommand } from '../core/run-command'
import {
  ADB,
  expoDump as dump,
  expoEmulator as emulator,
  focusOn,
  opensOf,
  tapsOf,
} from '../testing/expo-go'
import { recorded, recordedText } from '../testing/fixtures'
import { registry } from './index'

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

  it('takes a screen with no text, label or touch for loading', async () => {
    const blank = dump(36, 'open/shown.ui-tty.txt', (text) =>
      text
        .replace(/ text="[^"]*"/g, ' text=""')
        .replace(/content-desc=("[^"]*"|'[^']*')/g, 'content-desc=""')
        .replace(/clickable="true"/g, 'clickable="false"'),
    )
    const { context } = emulator(36, [
      blank,
      dump(36, 'open/onboarding.ui-tty.txt'),
      dump(36, 'open/dev-menu.ui-tty.txt'),
      dump(36, 'open/shown.ui-tty.txt'),
    ])

    const result = await runCommand(registry, 'expo-open', {}, context)

    expect(result).toMatchObject({
      ok: true,
      data: {
        closed: ['onboarding', 'dev-menu'],
        probe: true,
        route: '/appstate',
      },
    })
  })

  it('reads again after a still screen with no probe, and closes a sheet that came after it', async () => {
    const app = dump(36, 'open/shown.ui-tty.txt', (text) =>
      text.replace(/content-desc='loupe:[^']*'/, 'content-desc=""'),
    )
    const onboarding = dump(36, 'open/onboarding.ui-tty.txt')
    const { context, calls } = emulator(36, [app, onboarding, onboarding, app])

    const result = await runCommand(registry, 'expo-open', {}, context)

    expect(result).toMatchObject({
      ok: true,
      data: { closed: ['onboarding'], probe: false },
    })
    expect(tapsOf(calls)).toHaveLength(1)
  }, 15_000)

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

  it('gives not_idle with advice when the screen of the app never keeps still', async () => {
    const { context } = emulator(36, [
      { stdout: 'ERROR: could not get idle state.\n' },
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
        code: 'not_idle',
        message: expect.stringContaining('wait until the animation ends'),
      },
    })
  })
})
