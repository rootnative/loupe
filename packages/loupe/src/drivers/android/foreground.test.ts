import { describe, expect, it, vi } from 'vitest'
import { type LoupeError } from '../../core/errors'
import { byCommand, type FakeRun, fakeContext } from '../../testing/fake-exec'
import { API_LEVELS, recorded, recordedText } from '../../testing/fixtures'
import { selectAndroidDevice } from './devices'
import { isAppWindow, whileInFront } from './foreground'

const SETTINGS = 'com.android.settings'
const ADVICE =
  'is in front. Close it with "loupe dismiss" (a tap on Wait), then try again.'

function dump(level: number, screen: 'settings' | 'home'): FakeRun {
  return recorded(
    `api-${level}/none/rotation-1/${screen}/dumpsys-window-displays.txt`,
  )
}

/** The Settings dump, with the focus on the "isn't responding" dialog of `app`. */
function notResponding(level: number, app: string): FakeRun {
  const text = recordedText(
    `api-${level}/none/rotation-1/settings/dumpsys-window-displays.txt`,
  )
  const focus = /mCurrentFocus=Window\{(\S+) u0 [^}]+\}/
  if (!focus.test(text)) throw new Error(`No focus line on API ${level}.`)
  return {
    stdout: text.replace(
      focus,
      `mCurrentFocus=Window{$1 u0 Application Not Responding: ${app}}`,
    ),
  }
}

function emulator(level: number, dumps: readonly FakeRun[]) {
  const api = `api-${level}`
  const adb = 'adb -s emulator-5554'
  const { context, calls } = fakeContext(
    byCommand({
      'adb devices -l': recorded(`${api}/host/adb-devices-l.txt`),
      [`${adb} shell getprop`]: recorded(`${api}/device/getprop.txt`),
      [`${adb} shell dumpsys window displays`]: dumps,
    }),
  )
  return { calls, target: () => selectAndroidDevice(context) }
}

/** A phone on API 35, with the display dumps of the API 35 emulator. */
function phone(dumps: readonly FakeRun[]) {
  const adb = 'adb -s PHONE123'
  const { context, calls } = fakeContext(
    byCommand({
      'adb devices -l': {
        stdout:
          'List of devices attached\nPHONE123               device product:phone model:Phone_Model device:phone transport_id:4\n\n',
      },
      [`${adb} shell getprop`]: {
        stdout: '[ro.build.version.sdk]: [35]\n[sys.boot_completed]: [1]\n',
      },
      [`${adb} shell dumpsys window displays`]: dumps,
    }),
  )
  return { calls, target: () => selectAndroidDevice(context) }
}

function dumpCalls(calls: readonly { args: string[] }[]): number {
  return calls.filter((call) => call.args.includes('dumpsys')).length
}

describe('isAppWindow', () => {
  it.each([
    ['com.example.app/com.example.app.MainActivity', true],
    ['com.example.app/.MainActivity', true],
    ['com.example.app', true],
    ['com.example.app.debug/.MainActivity', false],
    ['com.example/.MainActivity', false],
    ['NotificationShade', false],
    ['PopupWindow:1a2b3c', false],
    ['Splash Screen com.example.app', false],
    [undefined, false],
  ])('%s → %s', (title, expected) => {
    expect(isAppWindow(title, 'com.example.app')).toBe(expected)
  })
})

describe.each(API_LEVELS)('whileInFront, on API %i', (level) => {
  it('takes while the app is in front, and checks it again after', async () => {
    const { calls, target } = emulator(level, [dump(level, 'settings')])
    const take = vi.fn(async () => 'png')

    const result = await whileInFront(await target(), SETTINGS, take)

    expect(result.value).toBe('png')
    expect(result.display).toMatchObject({ rotation: 1 })
    expect(take).toHaveBeenCalledOnce()
    expect(dumpCalls(calls)).toBe(2)
  })

  it('takes nothing while another app is in front', async () => {
    const { target } = emulator(level, [dump(level, 'home')])
    const take = vi.fn(async () => 'png')

    await expect(
      whileInFront(await target(), SETTINGS, take),
    ).rejects.toMatchObject({
      code: 'app_not_in_front',
      message: expect.stringContaining(
        'The focus is on com.google.android.apps.nexuslauncher/',
      ),
    })
    expect(take).not.toHaveBeenCalled()
  })

  it('points to dismiss when an "isn\'t responding" dialog is in front', async () => {
    const { target } = emulator(level, [notResponding(level, SETTINGS)])
    const take = vi.fn(async () => 'png')

    await expect(
      whileInFront(await target(), SETTINGS, take),
    ).rejects.toMatchObject({
      code: 'app_not_in_front',
      message: `${SETTINGS} isn't in front, so loupe does nothing on emulator-5554. An "isn't responding" dialog for ${SETTINGS} ${ADVICE}`,
    })
    expect(take).not.toHaveBeenCalled()
  })

  it('points to dismiss when the dialog shows during the capture', async () => {
    const { target } = emulator(level, [
      dump(level, 'settings'),
      notResponding(level, SETTINGS),
    ])

    await expect(
      whileInFront(await target(), SETTINGS, async () => 'png'),
    ).rejects.toMatchObject({
      code: 'app_not_in_front',
      message: `The focus moved away from ${SETTINGS} during the capture, so loupe dropped it. An "isn't responding" dialog for ${SETTINGS} ${ADVICE}`,
    })
  })

  it('drops the capture when the focus moves during it', async () => {
    const { target } = emulator(level, [
      dump(level, 'settings'),
      dump(level, 'home'),
    ])
    const take = vi.fn(async () => 'png')

    await expect(
      whileInFront(await target(), SETTINGS, take),
    ).rejects.toMatchObject({
      code: 'app_not_in_front',
      message: expect.stringContaining('moved away'),
    })
    expect(take).toHaveBeenCalledOnce()
  })
})

describe('whileInFront', () => {
  it('reads the display once on an emulator with no app', async () => {
    const { calls, target } = emulator(36, [dump(36, 'home')])

    const result = await whileInFront(await target(), undefined, async () => 1)

    expect(result.display).toMatchObject({ rotation: 0 })
    expect(dumpCalls(calls)).toBe(1)
  })

  it('needs the app on a real device, and reads nothing', async () => {
    const { calls, target } = phone([dump(35, 'settings')])
    const take = vi.fn(async () => 'png')

    await expect(
      whileInFront(await target(), undefined, take),
    ).rejects.toMatchObject({ code: 'invalid_input' })
    expect(take).not.toHaveBeenCalled()
    expect(dumpCalls(calls)).toBe(0)
  })

  it('takes on a real device while the app is in front', async () => {
    const { target } = phone([dump(35, 'settings')])

    const result = await whileInFront(await target(), SETTINGS, async () => 1)

    expect(result.value).toBe(1)
  })

  it("doesn't name the other app on a real device", async () => {
    const { target } = phone([dump(35, 'home')])

    const error = await whileInFront(await target(), SETTINGS, async () => 1)
      .then(() => undefined)
      .catch((caught: LoupeError) => caught)

    expect(error).toMatchObject({ code: 'app_not_in_front' })
    expect(error?.message).not.toContain('nexuslauncher')
  })
})

describe('whileInFront, on a phone', () => {
  it('names the app under test in the dialog advice, and no other app', async () => {
    const own = phone([notResponding(35, SETTINGS)])
    const other = phone([notResponding(35, 'com.example.mail')])

    await expect(
      whileInFront(await own.target(), SETTINGS, async () => 'png'),
    ).rejects.toMatchObject({
      message: expect.stringContaining(
        `An "isn't responding" dialog for ${SETTINGS} ${ADVICE}`,
      ),
    })
    await expect(
      whileInFront(await other.target(), SETTINGS, async () => 'png'),
    ).rejects.toMatchObject({
      message: `${SETTINGS} isn't in front, so loupe does nothing on PHONE123. An "isn't responding" dialog ${ADVICE}`,
    })
  })
})
