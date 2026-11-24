import { describe, expect, it } from 'vitest'
import {
  byCommand,
  type FakeHandler,
  type FakeRun,
  fakeContext,
} from '../../testing/fake-exec'
import { API_LEVELS, recorded, recordedText } from '../../testing/fixtures'
import { selectAndroidDevice } from './devices'
import { dismissAndroid, systemLayerOf } from './dismiss'
import { parseWindowDisplays } from './parse'

const EXPO_GO = 'host.exp.exponent'
const SUB_SETTINGS = 'com.android.settings/com.android.settings.SubSettings'
const SHADE = 'NotificationShade'
const NOT_RESPONDING =
  'Application Not Responding: com.google.android.apps.nexuslauncher'
const FAST = { limit: 0, interval: 0 }
const FOCUS = /mCurrentFocus=Window\{\S+ u0 [^}]+\}/
const NOT_IDLE = { stdout: 'ERROR: could not get idle state.\n' }

/** Round 5: the probe app in Expo Go, portrait, with nothing over it. */
function appDump(level: number): string {
  return recordedText(`api-${level}/probe/night/light/last.ui-tty.txt`)
}

/** The app's dump with one more node over the whole screen, on top. */
function withFullScreen(dump: string, attributes: string): string {
  const node = `<node index="9" text="" resource-id="scrim" class="android.widget.Button" package="${EXPO_GO}" checkable="false" checked="false" enabled="true" focusable="true" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[0,0][1080,2400]" ${attributes} />`
  return dump.replace('</hierarchy>', `${node}</hierarchy>`)
}

/** The dump with the focus on this window. */
function focusOn(dump: string, id: string, title: string): string {
  return dump.replace(FOCUS, `mCurrentFocus=Window{${id} u0 ${title}}`)
}

/** The smoke run's share sheet: the window dump and the input dump. */
const SHEET_DISPLAYS = recordedText(
  'api-36/smoke/sheets-share.dumpsys-window-displays.txt',
)
const SHEET_INPUT = recordedText('api-36/smoke/sheets-share.dumpsys-input.txt')
const INPUT_FOCUS = /(FocusedWindows:\n\s*displayId=0, name=')[^']*'/

/** The input dump with the input focus on this window: `<hash> <title>`. */
function inputOn(name: string): string {
  return SHEET_INPUT.replace(INPUT_FOCUS, `$1${name}'`)
}

/**
 * When the table has no `dumpsys input`, the input focus is on the window in
 * focus in the last `dumpsys window displays`, as on an idle device.
 */
function inputInStep(table: FakeHandler): FakeHandler {
  let focus = ''
  return (call) => {
    const run = table(call)
    const args = call.args.slice(2).join(' ')
    if (args === 'shell dumpsys window displays' && run) {
      const display = parseWindowDisplays(String(run.stdout ?? ''))
      focus = display?.focusId ? `${display.focusId} ${display.focus}` : ''
    }
    if (args === 'shell dumpsys input' && !run) {
      return { stdout: inputOn(focus) }
    }
    return run
  }
}

/** The title of the window in front while round 8 had the sheet open. */
function openTitle(level: number, round: string): string {
  const summary = recordedText(`api-${level}/sheets/summary.txt`)
  const block = summary
    .split(/\r?\n(?=\S)/)
    .find((part) => part.startsWith(`${round}\n`))
  const title = /^\s*open: (.+?) \(/m.exec(block ?? '')?.[1]
  if (!title) throw new Error(`No open window for ${round} on API ${level}`)
  return title
}

/**
 * The display dumps of round 8 on one level. The windows dump is the one
 * taken with the alert open: it has the app's main window and the alert.
 */
function round8(level: number) {
  const dir = `api-${level}/sheets`
  const main = recordedText(
    `${dir}/alert/back/before.dumpsys-window-displays.txt`,
  )
  const display = parseWindowDisplays(main)
  const focus = display?.focus ?? ''
  const focusId = display?.focusId ?? ''
  // The keyboard round ran in another Expo Go window: put the focus on the
  // main window of the windows dump.
  const keyboard = (when: string) =>
    focusOn(
      recordedText(`${dir}/keyboard/back/${when}.dumpsys-window-displays.txt`),
      focusId,
      focus,
    )
  return {
    main,
    dialog: recordedText(`${dir}/alert/back/open.dumpsys-window-displays.txt`),
    keyboard: keyboard('open'),
    keyboardHidden: keyboard('after'),
    on: (id: string, title: string) => focusOn(main, id, title),
  }
}

function emulator(
  level: number,
  displays: readonly string[],
  more: Record<string, FakeRun | readonly FakeRun[]> = {},
  serial = 'emulator-5554',
) {
  const phone = !serial.startsWith('emulator-')
  const adb = `adb -s ${serial}`
  const { context, calls } = fakeContext(
    inputInStep(
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
        [`${adb} shell dumpsys window displays`]: displays.map((stdout) => ({
          stdout,
        })),
        [`${adb} shell dumpsys window windows`]: recorded(
          `api-${level}/sheets/alert/back/open.dumpsys-window-windows.txt`,
        ),
        [`${adb} shell input keyevent KEYCODE_BACK`]: {},
        [`${adb} shell cmd statusbar collapse`]: {},
        [`${adb} exec-out uiautomator dump /dev/tty`]: {
          stdout: appDump(level),
        },
        ...Object.fromEntries(
          Object.entries(more).map(([args, run]) => [`${adb} ${args}`, run]),
        ),
      }),
    ),
  )
  const shellCalls = (pattern: RegExp) => () =>
    calls
      .map((call) => call.args.slice(3).join(' '))
      .filter((args) => pattern.test(args))
  return {
    target: () => selectAndroidDevice(context),
    sent: shellCalls(/keyevent|statusbar|input tap/),
    steps: shellCalls(/keyevent|statusbar|input tap|dumpsys input$/),
  }
}

const closed = (layer: string, way: string) => ({
  layer,
  way,
  ms: expect.any(Number),
})

describe.each(API_LEVELS)('dismissAndroid, on API %i', (level) => {
  const dumps = round8(level)

  it('sends no key when nothing is open', async () => {
    const { target, sent } = emulator(level, [dumps.main])

    expect(await dismissAndroid(await target(), EXPO_GO, FAST)).toEqual({
      app: EXPO_GO,
      closed: [],
    })
    expect(sent()).toEqual([])
  })

  it('closes an overlay that the app draws in its own window, with Back', async () => {
    const overlay = withFullScreen(
      appDump(level),
      'content-desc="Close overlay" clickable="true"',
    )
    const { target, sent } = emulator(level, [dumps.main], {
      'exec-out uiautomator dump /dev/tty': [
        { stdout: overlay },
        { stdout: appDump(level) },
      ],
    })

    expect(await dismissAndroid(await target(), EXPO_GO, FAST)).toEqual({
      app: EXPO_GO,
      closed: [
        {
          layer: 'app-overlay',
          label: 'Close overlay',
          way: 'back',
          ms: expect.any(Number),
        },
      ],
    })
    expect(sent()).toEqual(['input keyevent KEYCODE_BACK'])
  })

  it('sends no key for a full-screen touch with no label', async () => {
    const wrapper = withFullScreen(
      appDump(level),
      'content-desc="" clickable="true"',
    )
    const { target, sent } = emulator(level, [dumps.main], {
      'exec-out uiautomator dump /dev/tty': { stdout: wrapper },
    })

    expect(await dismissAndroid(await target(), EXPO_GO, FAST)).toEqual({
      app: EXPO_GO,
      closed: [],
    })
    expect(sent()).toEqual([])
  })

  it("fails when the app's overlay stays after Back", async () => {
    const overlay = withFullScreen(
      appDump(level),
      'content-desc="Close menu" clickable="true"',
    )
    const { target } = emulator(level, [dumps.main], {
      'exec-out uiautomator dump /dev/tty': { stdout: overlay },
    })

    await expect(
      dismissAndroid(await target(), EXPO_GO, FAST),
    ).rejects.toMatchObject({
      code: 'timeout',
      message:
        "The app's overlay still shows 0 ms after loupe tried to close it with Back.",
    })
  })

  it("sends no key, and says why, when the app's screen never keeps still", async () => {
    const { target, sent } = emulator(level, [dumps.main], {
      'exec-out uiautomator dump /dev/tty': NOT_IDLE,
    })

    expect(await dismissAndroid(await target(), EXPO_GO, FAST)).toEqual({
      app: EXPO_GO,
      closed: [],
      warnings: [expect.stringContaining('never kept still')],
    })
    expect(sent()).toEqual([])
  })

  it("closes the app's dialog with Back", async () => {
    const { target, sent } = emulator(level, [dumps.dialog, dumps.main])

    expect(await dismissAndroid(await target(), EXPO_GO, FAST)).toEqual({
      app: EXPO_GO,
      closed: [closed('app-dialog', 'back')],
    })
    expect(sent()).toEqual(['input keyevent KEYCODE_BACK'])
  })

  it('closes the keyboard with Back', async () => {
    const { target, sent } = emulator(level, [
      dumps.keyboard,
      dumps.keyboardHidden,
    ])

    expect(await dismissAndroid(await target(), EXPO_GO, FAST)).toEqual({
      app: EXPO_GO,
      closed: [closed('keyboard', 'back')],
    })
    expect(sent()).toEqual(['input keyevent KEYCODE_BACK'])
  })

  it.each([
    ['share', 'share-sheet'],
    ['permission', 'permission-dialog'],
  ])('closes the %s sheet with Back', async (round, layer) => {
    const sheet = dumps.on('5e7a11', openTitle(level, `${round}/back`))
    const { target, sent } = emulator(level, [sheet, dumps.main])

    expect(await dismissAndroid(await target(), EXPO_GO, FAST)).toEqual({
      app: EXPO_GO,
      closed: [closed(layer, 'back')],
    })
    expect(sent()).toEqual(['input keyevent KEYCODE_BACK'])
  })

  it.each(['shade', 'quick-settings'])(
    'closes the %s with a status bar collapse',
    async (round) => {
      const shade = dumps.on('5e7a11', openTitle(level, `${round}/collapse`))
      const { target, sent } = emulator(level, [shade, dumps.main])

      expect(await dismissAndroid(await target(), EXPO_GO, FAST)).toEqual({
        app: EXPO_GO,
        closed: [closed('notification-shade', 'collapse')],
      })
      expect(sent()).toEqual(['cmd statusbar collapse'])
    },
  )
})

describe('dismissAndroid', () => {
  const dumps = round8(36)
  const shade = (id = '5e7a11') => dumps.on(id, SHADE)

  it('closes each layer from the top with all', async () => {
    const { target, sent } = emulator(36, [shade(), dumps.dialog, dumps.main])

    expect(
      await dismissAndroid(await target(), EXPO_GO, { ...FAST, all: true }),
    ).toEqual({
      app: EXPO_GO,
      closed: [
        closed('notification-shade', 'collapse'),
        closed('app-dialog', 'back'),
      ],
    })
    expect(sent()).toEqual([
      'cmd statusbar collapse',
      'input keyevent KEYCODE_BACK',
    ])
  })

  it('closes only the top layer in one call, and names the next', async () => {
    const { target, sent } = emulator(36, [shade(), dumps.dialog])

    expect(await dismissAndroid(await target(), EXPO_GO, FAST)).toEqual({
      app: EXPO_GO,
      closed: [closed('notification-shade', 'collapse')],
      next: 'app-dialog',
    })
    expect(sent()).toEqual(['cmd statusbar collapse'])
  })

  it('stops after 5 layers with all', async () => {
    const { target, sent } = emulator(36, [
      shade('a1'),
      dumps.dialog,
      shade('a2'),
      dumps.dialog,
      shade('a3'),
      dumps.dialog,
    ])

    const result = await dismissAndroid(await target(), undefined, {
      ...FAST,
      all: true,
    })

    expect(result).toMatchObject({ next: 'app-dialog' })
    expect(result.app).toBeUndefined()
    expect(result.closed).toHaveLength(5)
    expect(sent()).toHaveLength(5)
  })

  it('sends no key into another app, and points to foreground', async () => {
    const { target, sent } = emulator(36, [dumps.on('5e7a11', SUB_SETTINGS)])

    await expect(
      dismissAndroid(await target(), EXPO_GO, FAST),
    ).rejects.toMatchObject({
      code: 'app_not_in_front',
      message: `${EXPO_GO} isn't in front of emulator-5554, and the window in front isn't a layer that loupe closes, so loupe sends no key. The focus is on ${SUB_SETTINGS}. Bring ${EXPO_GO} back with "loupe foreground ${EXPO_GO}", then try again.`,
    })
    expect(sent()).toEqual([])
  })

  it('names no other app on a phone, and needs the app there', async () => {
    const other = emulator(
      36,
      [dumps.on('5e7a11', SUB_SETTINGS)],
      {},
      'PHONE123',
    )
    const none = emulator(36, [dumps.main], {}, 'PHONE123')

    const error = await dismissAndroid(
      await other.target(),
      EXPO_GO,
      FAST,
    ).catch((caught: unknown) => caught)
    expect(error).toMatchObject({ code: 'app_not_in_front' })
    expect(String(error)).not.toContain('settings')
    await expect(
      dismissAndroid(await none.target(), undefined, FAST),
    ).rejects.toMatchObject({ code: 'invalid_input' })
  })

  it('sends no key when no window has the focus', async () => {
    const off = dumps.main.replace(FOCUS, 'mCurrentFocus=null')
    const { target, sent } = emulator(36, [off])

    await expect(
      dismissAndroid(await target(), EXPO_GO, FAST),
    ).rejects.toMatchObject({
      code: 'app_not_in_front',
      message: expect.stringContaining('No window has the focus'),
    })
    expect(sent()).toEqual([])
  })

  it('fails when the layer stays', async () => {
    const { target } = emulator(36, [dumps.dialog])

    await expect(
      dismissAndroid(await target(), EXPO_GO, FAST),
    ).rejects.toMatchObject({
      code: 'timeout',
      message:
        "The app's dialog still shows 0 ms after loupe tried to close it with Back.",
    })
  })

  it('names the layers it closed before a failure', async () => {
    const { target } = emulator(36, [shade(), dumps.on('9f3c21', SUB_SETTINGS)])

    await expect(
      dismissAndroid(await target(), EXPO_GO, { ...FAST, all: true }),
    ).rejects.toMatchObject({
      code: 'app_not_in_front',
      message: expect.stringMatching(
        /^loupe closed the notification shade with a status bar collapse \(\d+ ms\)\. host\.exp\.exponent isn't in front/,
      ),
    })
  })

  describe('the input focus, with the shade over the share sheet', () => {
    const sheet = parseWindowDisplays(SHEET_DISPLAYS)
    const onSheet = `${sheet?.focusId} ${sheet?.focus}`
    const shadeOver = focusOn(SHEET_DISPLAYS, '5e7a11', SHADE)
    const onShade = `5e7a11 ${SHADE}`
    const input = (...names: string[]) =>
      names.map((name) => ({ stdout: inputOn(name) }))

    it('sends Back only when the input focus left the shade', async () => {
      const { target, steps } = emulator(
        36,
        [shadeOver, SHEET_DISPLAYS, dumps.main],
        { 'shell dumpsys input': input(onShade, onSheet) },
      )

      expect(
        await dismissAndroid(await target(), EXPO_GO, {
          limit: 1000,
          interval: 0,
          all: true,
        }),
      ).toEqual({
        app: EXPO_GO,
        closed: [
          closed('notification-shade', 'collapse'),
          closed('share-sheet', 'back'),
        ],
      })
      expect(steps()).toEqual([
        'cmd statusbar collapse',
        'dumpsys input',
        'dumpsys input',
        'input keyevent KEYCODE_BACK',
      ])
    })

    it('sends no key when the input focus stays on the shade', async () => {
      const { target, sent } = emulator(36, [shadeOver, SHEET_DISPLAYS], {
        'shell dumpsys input': input(onShade),
      })

      await expect(
        dismissAndroid(await target(), EXPO_GO, { ...FAST, all: true }),
      ).rejects.toMatchObject({
        code: 'timeout',
        message: expect.stringMatching(
          /^loupe closed the notification shade with a status bar collapse \(\d+ ms\)\. The input focus didn't move to the share sheet within 0 ms, so loupe sent no key: it could reach another window\. Try again in a moment\.$/,
        ),
      })
      expect(sent()).toEqual(['cmd statusbar collapse'])
    })

    it("doesn't wait when the input dump has no focus that it can read", async () => {
      const { target, steps } = emulator(36, [SHEET_DISPLAYS, dumps.main], {
        'shell dumpsys input': { stdout: 'INPUT MANAGER (dumpsys input)\n' },
      })

      expect(await dismissAndroid(await target(), EXPO_GO, FAST)).toEqual({
        app: EXPO_GO,
        closed: [closed('share-sheet', 'back')],
      })
      expect(steps()).toEqual(['dumpsys input', 'input keyevent KEYCODE_BACK'])
    })
  })

  it("doesn't close another window of an app", async () => {
    const { target, sent } = emulator(36, [dumps.on('5a57c5', 'InputMethod')])

    await expect(
      dismissAndroid(await target(), undefined, FAST),
    ).rejects.toMatchObject({
      code: 'unsupported',
      message: expect.stringContaining(
        'belongs to com.google.android.inputmethod.latin, but it',
      ),
    })
    expect(sent()).toEqual([])
  })

  it('taps Wait in an "isn\'t responding" dialog', async () => {
    // Round 5 on API 34: the dialog for the launcher, over Expo Go.
    const api34 = round8(34)
    const { target, sent } = emulator(
      34,
      [api34.on('ed7bf89', NOT_RESPONDING), api34.main],
      {
        'exec-out uiautomator dump /dev/tty': recorded(
          'api-34/probe/corner/rotation-0/not-responding.ui-tty.txt',
        ),
        'shell input tap 540 1358': {},
      },
    )

    expect(await dismissAndroid(await target(), EXPO_GO, FAST)).toEqual({
      app: EXPO_GO,
      closed: [closed('not-responding', 'tap-wait')],
    })
    expect(sent()).toEqual(['input tap 540 1358'])
  })
})

/**
 * Round 9b: Gboard's stylus mode after a console pinch, on the probe app's
 * field. `open`: the "Try out your stylus" sheet over the handwriting
 * toolbar; `2-cancel`: the toolbar alone; `3-escape`: neither.
 */
describe.each([
  [35, '600 2211'],
  [36, '600 2274'],
])('dismissAndroid in the stylus mode, on API %i', (level, cancel) => {
  const dir = `api-${level}/stylus/pinch/after-1`
  const displays = (state: string) =>
    recordedText(`${dir}/${state}.dumpsys-window-displays.txt`)
  const withSheet = recordedText(`${dir}/2-cancel.send.txt.ui-windows.txt`)
  // Round 9b has no dump of each window after Cancel: the same dump with no
  // Cancel button stands for it.
  const noSheet = { stdout: withSheet.replaceAll('android:id/closeButton', '') }

  function stylus(states: readonly string[], windows: readonly FakeRun[]) {
    return emulator(level, states.map(displays), {
      'shell dumpsys window windows': recorded(
        `${dir}/open.dumpsys-window-windows.txt`,
      ),
      'exec-out uiautomator dump --windows /dev/tty': windows,
      [`shell input tap ${cancel}`]: {},
      'shell input keyevent KEYCODE_ESCAPE': {},
    })
  }

  it('taps Cancel on the stylus sheet, and names the keyboard under it', async () => {
    const { target, sent } = stylus(
      ['open', '2-cancel'],
      [{ stdout: withSheet }, noSheet],
    )

    expect(await dismissAndroid(await target(), EXPO_GO, FAST)).toEqual({
      app: EXPO_GO,
      closed: [closed('stylus-sheet', 'tap-cancel')],
      next: 'keyboard',
    })
    expect(sent()).toEqual([`input tap ${cancel}`])
  })

  it('closes the sheet, then the keyboard with Escape, with all', async () => {
    const { target, sent } = stylus(
      ['open', '2-cancel', '3-escape'],
      [{ stdout: withSheet }, noSheet],
    )

    expect(
      await dismissAndroid(await target(), EXPO_GO, { ...FAST, all: true }),
    ).toEqual({
      app: EXPO_GO,
      closed: [
        closed('stylus-sheet', 'tap-cancel'),
        closed('keyboard', 'escape'),
      ],
    })
    expect(sent()).toEqual([
      `input tap ${cancel}`,
      'input keyevent KEYCODE_ESCAPE',
    ])
  })

  it('closes the handwriting toolbar with Escape, not Back', async () => {
    const { target, sent } = stylus(['2-cancel', '3-escape'], [noSheet])

    expect(await dismissAndroid(await target(), EXPO_GO, FAST)).toEqual({
      app: EXPO_GO,
      closed: [closed('keyboard', 'escape')],
    })
    expect(sent()).toEqual(['input keyevent KEYCODE_ESCAPE'])
  })

  it('fails when the sheet stays after the tap', async () => {
    const { target } = stylus(['open'], [{ stdout: withSheet }])

    await expect(
      dismissAndroid(await target(), EXPO_GO, FAST),
    ).rejects.toMatchObject({
      code: 'timeout',
      message: expect.stringContaining(
        `"Try out your stylus" sheet still shows 0 ms after loupe tried to close it with a tap on Cancel.`,
      ),
    })
  })
})

describe('systemLayerOf', () => {
  it.each(API_LEVELS)(
    'knows each system sheet of round 8 on API %i',
    (level) => {
      expect(systemLayerOf(openTitle(level, 'share/back'))).toBe('share-sheet')
      expect(systemLayerOf(openTitle(level, 'permission/back'))).toBe(
        'permission-dialog',
      )
      expect(systemLayerOf(openTitle(level, 'shade/back'))).toBe(
        'notification-shade',
      )
      expect(systemLayerOf(openTitle(level, 'quick-settings/back'))).toBe(
        'notification-shade',
      )
      expect(systemLayerOf(openTitle(level, 'nothing/back'))).toBeUndefined()
    },
  )

  it('knows an "isn\'t responding" dialog, and no chooser of an app', () => {
    expect(systemLayerOf(NOT_RESPONDING)).toBe('not-responding')
    expect(
      systemLayerOf('com.example.app/com.example.app.ChooserActivity'),
    ).toBeUndefined()
  })
})
