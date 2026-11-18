import { describe, expect, it } from 'vitest'
import { byCommand, type FakeRun, fakeContext } from '../../testing/fake-exec'
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

/** The dump with the focus on this window. */
function focusOn(dump: string, id: string, title: string): string {
  return dump.replace(FOCUS, `mCurrentFocus=Window{${id} u0 ${title}}`)
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
      ...Object.fromEntries(
        Object.entries(more).map(([args, run]) => [`${adb} ${args}`, run]),
      ),
    }),
  )
  const sent = () =>
    calls
      .map((call) => call.args.slice(3).join(' '))
      .filter((args) => /keyevent|statusbar|input tap/.test(args))
  return { target: () => selectAndroidDevice(context), sent }
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

  it("closes Gboard's stylus sheet, whose keyboard source has no height", async () => {
    // The smoke run on API 36: the field tap showed "Try out your stylus".
    const smoke = (file: string) => recordedText(`api-36/smoke/${file}`)
    const { target, sent } = emulator(
      36,
      [
        smoke('keyboard-open.displays.txt'),
        smoke('keyboard-before.displays.txt'),
      ],
      {
        'shell dumpsys window windows': recorded(
          'api-36/smoke/keyboard-open.windows.txt',
        ),
      },
    )

    expect(await dismissAndroid(await target(), EXPO_GO, FAST)).toEqual({
      app: EXPO_GO,
      closed: [closed('keyboard', 'back')],
    })
    expect(sent()).toEqual(['input keyevent KEYCODE_BACK'])
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
