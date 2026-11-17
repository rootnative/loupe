import { describe, expect, it } from 'vitest'
import { run } from '../cli/run'
import { byCommand, type FakeRun, fakeContext } from '../testing/fake-exec'
import { recorded, recordedText } from '../testing/fixtures'
import { registry } from './index'

const ADB = 'adb -s emulator-5554'
const EXPERIENCE =
  'host.exp.exponent/host.exp.exponent.experience.ExperienceActivity'
const LAUNCHER =
  'com.google.android.apps.nexuslauncher/com.google.android.apps.nexuslauncher.NexusLauncherActivity'
const SUB_SETTINGS = 'com.android.settings/com.android.settings.SubSettings'
const DISPLAY = recordedText(
  'api-36/none/rotation-1/settings/dumpsys-window-displays.txt',
)
const TASK_LOCK = 'api-36/app-switch/expo-go/task-lock'

/** The recorded display dump, with this window in focus. */
function focusOn(title: string): FakeRun {
  return {
    stdout: DISPLAY.replace(
      /mCurrentFocus=Window\{(\S+) u0 [^}]+\}/,
      `mCurrentFocus=Window{$1 u0 ${title}}`,
    ),
  }
}

/**
 * An API 36 emulator with the Expo Go app in front (round 7b): the recent
 * tasks never put the home screen first, so the way back is a task lock.
 */
function emulator(focus: readonly string[]) {
  const { context } = fakeContext(
    byCommand({
      'adb devices -l': recorded('api-36/host/adb-devices-l.txt'),
      [`${ADB} shell getprop`]: recorded('api-36/device/getprop.txt'),
      [`${ADB} shell dumpsys window displays`]: focus.map(focusOn),
      [`${ADB} shell dumpsys activity recents`]: recorded(
        'api-36/app-switch/expo-go/recents-twice/before.recents.txt',
      ),
      [`${ADB} shell input keyevent KEYCODE_HOME`]: {},
      [`${ADB} shell am task lock 7`]: recorded(
        `${TASK_LOCK}/task-lock.am.txt`,
      ),
      [`${ADB} shell am task lock 9`]: recorded(
        `${TASK_LOCK}/task-lock.am.txt`,
      ),
      [`${ADB} shell am task lock stop`]: recorded(
        `${TASK_LOCK}/task-lock.stop.txt`,
      ),
    }),
  )
  return context
}

async function cli(args: string[], focus: readonly string[], isTTY = true) {
  const out: string[] = []
  const errors: string[] = []
  const io = {
    out: (text: string) => out.push(text),
    err: (text: string) => errors.push(text),
    isTTY,
  }
  const code = await run(args, io, registry, emulator(focus))
  return { code, out: out.join('\n'), errors: errors.join('\n') }
}

describe('foreground', () => {
  it('brings the app back, and says how', async () => {
    const { code, out } = await cli(
      ['foreground', 'com.android.settings'],
      [EXPERIENCE, SUB_SETTINGS],
    )

    expect(code).toBe(0)
    expect(out).toMatch(
      /^Brought com\.android\.settings to the front in \d+ ms, with a task lock; Android shows an "App unpinned" toast for a few seconds$/,
    )
  })

  it('gives the way, the ways it tried, and the task', async () => {
    const { out } = await cli(
      ['foreground', '--app', 'com.android.settings'],
      [EXPERIENCE, SUB_SETTINGS],
      false,
    )

    expect(JSON.parse(out)).toMatchObject({
      ok: true,
      data: {
        app: 'com.android.settings',
        way: 'task-lock',
        tried: ['task-lock'],
        task: 7,
      },
    })
  })

  it('needs the app', async () => {
    expect(await cli(['foreground'], [EXPERIENCE])).toMatchObject({ code: 2 })
  })
})

describe('background', () => {
  it('sends the app in front to the background', async () => {
    expect(await cli(['background'], [EXPERIENCE, LAUNCHER])).toEqual({
      code: 0,
      out: 'Sent host.exp.exponent to the background',
      errors: '',
    })
  })

  it('brings it back after --for', async () => {
    const { code, out } = await cli(
      ['background', '--for', '0', '--app', 'host.exp.exponent'],
      [EXPERIENCE, LAUNCHER, LAUNCHER, EXPERIENCE],
    )

    expect(code).toBe(0)
    expect(out).toMatch(
      /^Sent host\.exp\.exponent to the background for \d+ ms\. Brought host\.exp\.exponent to the front in \d+ ms, with a task lock; /,
    )
  })

  it('refuses a wait with no --for', async () => {
    const { code, errors } = await cli(
      ['background', '--wait-still'],
      [EXPERIENCE],
    )

    expect(code).toBe(2)
    expect(errors).toContain('The wait options need --for')
  })
})
