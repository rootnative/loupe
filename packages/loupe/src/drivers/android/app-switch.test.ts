import { describe, expect, it } from 'vitest'
import { byCommand, type FakeRun, fakeContext } from '../../testing/fake-exec'
import { recorded, recordedText } from '../../testing/fixtures'
import { backgroundAndroid, foregroundAndroid } from './app-switch'
import { selectAndroidDevice } from './devices'

const EXPO_GO = 'host.exp.exponent'
const SETTINGS = 'com.android.settings'
const LAUNCHER =
  'com.google.android.apps.nexuslauncher/com.google.android.apps.nexuslauncher.NexusLauncherActivity'
const EXPERIENCE = `${EXPO_GO}/${EXPO_GO}.experience.ExperienceActivity`
const SUB_SETTINGS = `${SETTINGS}/${SETTINGS}.SubSettings`

const DISPLAY = recordedText(
  'api-36/none/rotation-1/settings/dumpsys-window-displays.txt',
)

/** The recorded display dump, with this window in focus. */
function focusOn(title: string): FakeRun {
  return {
    stdout: DISPLAY.replace(
      /mCurrentFocus=Window\{(\S+) u0 [^}]+\}/,
      `mCurrentFocus=Window{$1 u0 ${title}}`,
    ),
  }
}

/** Round 7b, API 36: after HOME, the Expo Go app is the most recent task (9). */
const HOME_RECENTS = recorded(
  'api-36/app-switch/expo-go/recents-twice/home.recents.txt',
)
/** Round 7b, API 36: the Expo Go app in front; Settings is task 7. */
const APP_RECENTS = recorded(
  'api-36/app-switch/expo-go/recents-twice/before.recents.txt',
)

const FAST = { recentsPause: 0, limit: 0, interval: 0 }

function emulator(
  focus: readonly string[],
  recents: FakeRun | readonly FakeRun[],
  more: Record<string, FakeRun> = {},
  serial = 'emulator-5554',
) {
  const phone = !serial.startsWith('emulator-')
  const adb = `adb -s ${serial}`
  const { context, calls } = fakeContext(
    byCommand({
      'adb devices -l': phone
        ? {
            stdout: `List of devices attached\n${serial}               device product:phone model:Phone_Model device:phone transport_id:4\n\n`,
          }
        : recorded('api-36/host/adb-devices-l.txt'),
      [`${adb} shell getprop`]: phone
        ? {
            stdout: '[ro.build.version.sdk]: [36]\n[sys.boot_completed]: [1]\n',
          }
        : recorded('api-36/device/getprop.txt'),
      [`${adb} shell dumpsys window displays`]: focus.map(focusOn),
      [`${adb} shell dumpsys activity recents`]: recents,
      [`${adb} shell input keyevent KEYCODE_HOME`]: {},
      [`${adb} shell input keyevent KEYCODE_APP_SWITCH`]: {},
      [`${adb} shell am task lock 9`]: recorded(
        'api-36/app-switch/expo-go/task-lock/task-lock.am.txt',
      ),
      [`${adb} shell am task lock 7`]: recorded(
        'api-36/app-switch/expo-go/task-lock/task-lock.am.txt',
      ),
      [`${adb} shell am task lock stop`]: recorded(
        'api-36/app-switch/expo-go/task-lock/task-lock.stop.txt',
      ),
      ...Object.fromEntries(
        Object.entries(more).map(([args, run]) => [`${adb} ${args}`, run]),
      ),
    }),
  )
  const sent = () =>
    calls
      .map((call) => call.args.slice(3).join(' '))
      .filter((args) => /keyevent|task lock/.test(args))
  return { target: () => selectAndroidDevice(context), sent }
}

describe('foregroundAndroid', () => {
  it('does nothing when the app is in front', async () => {
    const { target, sent } = emulator([EXPERIENCE], APP_RECENTS)

    expect(await foregroundAndroid(await target(), EXPO_GO, FAST)).toEqual({
      way: 'in-front',
      tried: [],
      ms: 0,
    })
    expect(sent()).toEqual([])
  })

  it('takes the Recents key when the home screen is in front, and the app is the most recent', async () => {
    const { target, sent } = emulator([LAUNCHER, EXPERIENCE], HOME_RECENTS)

    expect(
      await foregroundAndroid(await target(), EXPO_GO, FAST),
    ).toMatchObject({ way: 'recents', tried: ['recents'], task: 9 })
    expect(sent()).toEqual([
      'input keyevent KEYCODE_APP_SWITCH',
      'input keyevent KEYCODE_APP_SWITCH',
    ])
  })

  it('locks the task when the Recents key leaves the launcher in front', async () => {
    // As Settings on API 34: Recents said "No recent items".
    const { target, sent } = emulator(
      [LAUNCHER, LAUNCHER, EXPERIENCE],
      HOME_RECENTS,
    )

    expect(
      await foregroundAndroid(await target(), EXPO_GO, FAST),
    ).toMatchObject({ way: 'task-lock', tried: ['recents', 'task-lock'] })
    expect(sent()).toEqual([
      'input keyevent KEYCODE_APP_SWITCH',
      'input keyevent KEYCODE_APP_SWITCH',
      'am task lock 9',
      'am task lock stop',
    ])
  })

  it('locks the task at once when another app is in front', async () => {
    const { target, sent } = emulator([EXPERIENCE, SUB_SETTINGS], APP_RECENTS)

    expect(
      await foregroundAndroid(await target(), SETTINGS, FAST),
    ).toMatchObject({ way: 'task-lock', tried: ['task-lock'], task: 7 })
    expect(sent()).toEqual(['am task lock 7', 'am task lock stop'])
  })

  it('fails when the app has no task, or neither way brings it back', async () => {
    const none = emulator([LAUNCHER], HOME_RECENTS)
    const stuck = emulator([LAUNCHER], HOME_RECENTS)

    await expect(
      foregroundAndroid(await none.target(), 'com.example.none', FAST),
    ).rejects.toMatchObject({
      code: 'app_not_in_front',
      message: expect.stringContaining('has no task in the recent tasks'),
    })
    await expect(
      foregroundAndroid(await stuck.target(), EXPO_GO, FAST),
    ).rejects.toMatchObject({
      code: 'app_not_in_front',
      message: `${EXPO_GO} isn't back in front after recents and task-lock on emulator-5554.`,
    })
    expect(stuck.sent().at(-1)).toBe('am task lock stop')
  })

  it('points to dismiss when the app shows an "isn\'t responding" dialog', async () => {
    const hung = emulator(
      [LAUNCHER, `Application Not Responding: ${EXPO_GO}`],
      HOME_RECENTS,
    )

    await expect(
      foregroundAndroid(await hung.target(), EXPO_GO, FAST),
    ).rejects.toMatchObject({
      code: 'app_not_in_front',
      message: `${EXPO_GO} isn't back in front after recents and task-lock on emulator-5554. An "isn't responding" dialog for ${EXPO_GO} is in front. Close it with "loupe dismiss" (a tap on Wait), then try again.`,
    })
  })

  it("doesn't lock a task on a phone that asks for the lock screen to end it", async () => {
    const { target, sent } = emulator(
      [LAUNCHER, LAUNCHER],
      HOME_RECENTS,
      {
        'shell settings get secure lock_to_app_exit_locked': { stdout: '1\n' },
      },
      'PHONE123',
    )

    await expect(
      foregroundAndroid(await target(), EXPO_GO, FAST),
    ).rejects.toMatchObject({
      code: 'app_not_in_front',
      message: expect.stringContaining('asks for the lock screen'),
    })
    expect(sent()).not.toContain('am task lock 9')
  })
})

describe('backgroundAndroid', () => {
  it('sends the app in front to the background', async () => {
    const { target, sent } = emulator([EXPERIENCE, LAUNCHER], APP_RECENTS)

    expect(
      await backgroundAndroid(await target(), undefined, undefined, FAST),
    ).toEqual({ app: EXPO_GO })
    expect(sent()).toEqual(['input keyevent KEYCODE_HOME'])
  })

  it('fails when the home screen is in front, or the app stays in front', async () => {
    const home = emulator([LAUNCHER], HOME_RECENTS)
    const stays = emulator([EXPERIENCE], APP_RECENTS)

    await expect(
      backgroundAndroid(await home.target(), undefined, undefined, FAST),
    ).rejects.toMatchObject({
      code: 'app_not_in_front',
      message: `No app is in front of emulator-5554 (the focus is on ${LAUNCHER}), so loupe sends none to the background. Open the app, then try again.`,
    })
    await expect(
      backgroundAndroid(await stays.target(), EXPO_GO, undefined, FAST),
    ).rejects.toMatchObject({ code: 'timeout' })
  })

  it('needs the app on a phone', async () => {
    const { target } = emulator([EXPERIENCE], APP_RECENTS, {}, 'PHONE123')

    await expect(
      backgroundAndroid(await target(), undefined, undefined, FAST),
    ).rejects.toMatchObject({ code: 'invalid_input' })
  })

  it('brings it back after the time, with the Recents key', async () => {
    // The app in front, the home screen after HOME, then the app again.
    const { target, sent } = emulator(
      [EXPERIENCE, LAUNCHER, LAUNCHER, EXPERIENCE],
      [APP_RECENTS, HOME_RECENTS],
    )

    const result = await backgroundAndroid(await target(), EXPO_GO, 0, FAST)

    expect(result).toMatchObject({
      app: EXPO_GO,
      away: expect.any(Number),
      back: { way: 'recents', task: 9 },
    })
    expect(sent()).toEqual([
      'input keyevent KEYCODE_HOME',
      'input keyevent KEYCODE_APP_SWITCH',
      'input keyevent KEYCODE_APP_SWITCH',
    ])
  })
})
