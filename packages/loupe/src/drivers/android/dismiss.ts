import { setTimeout as sleep } from 'node:timers/promises'
import { labelledOverlays } from '../../core/check'
import { elementsOnScreen, findElement } from '../../core/element'
import { LoupeError } from '../../core/errors'
import { type Point, rectCentre } from '../../core/units'
import { type AndroidTarget } from './devices'
import { dumpWindowDisplays, windowDisplayOf } from './display'
import { requireAppOnDevice } from './foreground'
import {
  type InsetSource,
  NOT_RESPONDING,
  parseInputFocus,
  parseWindowInsets,
  parseWindowList,
  type WindowDisplay,
  type WindowEntry,
} from './parse'
import { onScreen } from './touch'
import { readAndroidUi, readEachWindow, readWindowTree } from './ui'

/**
 * The layers that `dismiss` closes: the keyboard, the "Try out your stylus"
 * sheet of Gboard's stylus mode, a dialog or a modal of the app, an overlay
 * that the app draws in its own window, the system share sheet, the
 * permission dialog, the notification shade (also with the quick settings
 * open), and an "isn't responding" dialog.
 */
export const LAYERS = [
  'keyboard',
  'stylus-sheet',
  'app-dialog',
  'app-overlay',
  'share-sheet',
  'permission-dialog',
  'notification-shade',
  'not-responding',
] as const

export type Layer = (typeof LAYERS)[number]

/**
 * How loupe closes a layer. `back`: the Back key. `escape`: the Escape key,
 * for the keyboard in Gboard's stylus mode, where Back also reaches the app.
 * `tap-cancel`: a tap on Cancel in the "Try out your stylus" sheet, which
 * Escape doesn't close. `collapse`: `cmd statusbar collapse`, which closes
 * the shade and the quick settings in one step; Back closes only one level
 * of the quick settings. `tap-wait`: a tap on "Wait" in an "isn't
 * responding" dialog, so the app gets more time.
 */
export const DISMISS_WAYS = [
  'back',
  'escape',
  'tap-cancel',
  'collapse',
  'tap-wait',
] as const

export type DismissWay = (typeof DISMISS_WAYS)[number]

/** The most layers that one call closes, with `all`. */
export const MAX_LAYERS = 5

export interface Closed {
  layer: Layer
  /** The label of an `app-overlay`: its scrim or its outside-press region. */
  label?: string
  way: DismissWay
  /** Milliseconds from the key, command or tap until the layer was gone. */
  ms: number
}

export interface Dismissed {
  /**
   * The package under the layers. Left out when a layer still shows and
   * there was no `app`.
   */
  app?: string
  /** Each layer that loupe closed, from the top. Empty: none was open. */
  closed: Closed[]
  /** The layer that shows now, when loupe stopped before the app. */
  next?: Layer
  warnings?: string[]
}

export interface DismissOptions {
  /** Close each layer, up to `MAX_LAYERS`. Default: only the top one. */
  all?: boolean
  /** Milliseconds to wait for a layer to go. Default: 5000. */
  limit?: number
  /** Milliseconds between two reads. Default: 250. */
  interval?: number
}

const LAYER_NAMES: Record<Layer, string> = {
  keyboard: 'the keyboard',
  'stylus-sheet': `the keyboard's "Try out your stylus" sheet`,
  'app-dialog': "the app's dialog",
  'app-overlay': "the app's overlay",
  'share-sheet': 'the share sheet',
  'permission-dialog': 'the permission dialog',
  'notification-shade': 'the notification shade',
  'not-responding': `the "isn't responding" dialog`,
}

const WAY_NAMES: Record<DismissWay, string> = {
  back: 'with Back',
  escape: 'with Escape',
  'tap-cancel': 'with a tap on Cancel',
  collapse: 'with a status bar collapse',
  'tap-wait': 'with a tap on Wait',
}

/** For a person, with no capital: `the share sheet`. */
export function describeLayer(layer: Layer): string {
  return LAYER_NAMES[layer]
}

/** For a person: `the share sheet with Back (152 ms)`. */
export function describeClosed({ layer, label, way, ms }: Closed): string {
  const named = label === undefined ? '' : ` "${label}"`
  return `${LAYER_NAMES[layer]}${named} ${WAY_NAMES[way]} (${ms} ms)`
}

const SHARE_SHEET_PACKAGES = new Set(['android', 'com.android.intentresolver'])
const IME_TYPES = new Set(['ime', 'ITYPE_IME'])
const WAIT_BUTTON = 'android:id/aerr_wait'
const CANCEL_BUTTON = 'android:id/closeButton'
const INPUT_METHOD_WINDOW = 'TYPE_INPUT_METHOD'
/** A keyboard's source is this share of the screen height or more. */
const KEYBOARD_SHARE = 1 / 5

type SystemLayer = Extract<
  Layer,
  'share-sheet' | 'permission-dialog' | 'notification-shade' | 'not-responding'
>

/**
 * The layer of a system window, from the title of the focus: the share
 * sheet is a `ChooserActivity…` of `android` up to API 33 and of the intent
 * resolver from API 34; the permission dialog is the
 * `GrantPermissionsActivity` of the permission controller.
 */
export function systemLayerOf(title: string): SystemLayer | undefined {
  if (title === 'NotificationShade') return 'notification-shade'
  if (title.startsWith(NOT_RESPONDING)) return 'not-responding'

  const [owner = '', activity = ''] = title.split('/')
  const name = activity.slice(activity.lastIndexOf('.') + 1)
  if (SHARE_SHEET_PACKAGES.has(owner) && name.startsWith('ChooserActivity')) {
    return 'share-sheet'
  }
  if (
    owner.endsWith('.permissioncontroller') &&
    name === 'GrantPermissionsActivity'
  ) {
    return 'permission-dialog'
  }
  return undefined
}

/**
 * What the keyboard's inset source shows: the keyboard has no window in
 * focus. `handwriting`: visible, but lower than a fifth of the screen. That
 * is Gboard's stylus mode, which a touch from a stylus source starts (the
 * emulator console's touchscreen is one): its handwriting toolbar gives the
 * source 0 px on API 36 and 63 px on API 35, and its "Try out your stylus"
 * sheet fills the screen with no change to the source.
 */
type KeyboardShows = 'none' | 'keyboard' | 'handwriting'

interface Screen {
  display: WindowDisplay
  keyboard: KeyboardShows
}

type Front =
  | {
      kind: 'layer'
      layer: Exclude<Layer, 'stylus-sheet' | 'app-overlay'>
      window?: string
    }
  | { kind: 'layer'; layer: 'stylus-sheet'; cancel: Point }
  | { kind: 'layer'; layer: 'app-overlay'; app: string; label: string }
  | { kind: 'app'; app: string; warning?: string }

type LayerFront = Extract<Front, { kind: 'layer' }>

const KEYBOARD: LayerFront = { kind: 'layer', layer: 'keyboard' }

function keyboardOf(
  ime: InsetSource | undefined,
  display: WindowDisplay,
): KeyboardShows {
  if (!ime) return 'none'
  return ime.frame.height >= display.current.height * KEYBOARD_SHARE
    ? 'keyboard'
    : 'handwriting'
}

async function readScreen(target: AndroidTarget): Promise<Screen> {
  const dump = await dumpWindowDisplays(target)
  const display = windowDisplayOf(target, dump)
  const ime = parseWindowInsets(dump)?.sources.find(
    ({ type, visible }) => IME_TYPES.has(type) && visible,
  )
  return { display, keyboard: keyboardOf(ime, display) }
}

async function windowOf(
  target: AndroidTarget,
  id: string,
): Promise<WindowEntry | undefined> {
  const dump = await target.adb.text(['shell', 'dumpsys', 'window', 'windows'])
  return parseWindowList(dump).find((window) => window.id === id)
}

/**
 * The point of Cancel in the "Try out your stylus" sheet, in px. The sheet
 * is in the keyboard's own window, so only a dump of each window has it.
 * Cancel is `android:id/closeButton` there, in each language.
 */
async function stylusSheetCancel(
  target: AndroidTarget,
  display: WindowDisplay,
): Promise<Point | undefined> {
  const { display: state, windows } = await readEachWindow(target, display)
  const [button] = windows
    .filter(({ type }) => type === INPUT_METHOD_WINDOW)
    .flatMap(({ nodes }) =>
      elementsOnScreen(nodes, { by: 'id', value: CANCEL_BUTTON }, state.size),
    )
  return button && onScreen(state, rectCentre(button.frame))
}

/** The keyboard, or the stylus sheet over it when the sheet shows. */
async function keyboardFront(
  target: AndroidTarget,
  { display, keyboard }: Screen,
): Promise<LayerFront> {
  if (keyboard !== 'handwriting') return KEYBOARD
  const cancel = await stylusSheetCancel(target, display)
  return cancel ? { kind: 'layer', layer: 'stylus-sheet', cancel } : KEYBOARD
}

function noFocus(target: AndroidTarget): LoupeError {
  return new LoupeError(
    'app_not_in_front',
    `No window has the focus on ${target.serial}, so loupe sends no key. The screen can be off or locked, or a window can be about to open: try again in a moment.`,
  )
}

function otherInFront(
  target: AndroidTarget,
  app: string,
  focus: string,
): LoupeError {
  // On a real device, the name of the other app is the user's data.
  const where = target.kind === 'device' ? '' : ` The focus is on ${focus}.`
  return new LoupeError(
    'app_not_in_front',
    `${app} isn't in front of ${target.serial}, and the window in front isn't a layer that loupe closes, so loupe sends no key.${where} Bring ${app} back with "loupe foreground ${app}", then try again.`,
  )
}

function unknownWindow(owner: string, type: string | undefined): LoupeError {
  const kind = type ? ` (type ${type})` : ''
  return new LoupeError(
    'unsupported',
    `The window in front belongs to ${owner}, but it's neither its main window nor a dialog${kind}, so loupe doesn't close it. A window such as a splash screen shows only for a moment: try again then. If Back closes it, press back with the key command.`,
  )
}

/** The top labelled overlay in the app's own window, if one shows. */
async function topOverlay(
  target: AndroidTarget,
  app: string,
): Promise<string | undefined> {
  const ui = await readAndroidUi(target, app)
  return labelledOverlays({ ...ui, app }).at(-1)?.label
}

/**
 * The app's main window is in front. An overlay that the app draws in it,
 * such as the menu or the sheet of a component library, has no window of
 * its own: its scrim, or the region that closes it on an outside press, is
 * a full-screen node with a label and a touch. A screen that never keeps
 * still can't be read, so loupe sends no key and says why.
 */
async function appFront(target: AndroidTarget, app: string): Promise<Front> {
  try {
    const label = await topOverlay(target, app)
    return label === undefined
      ? { kind: 'app', app }
      : { kind: 'layer', layer: 'app-overlay', app, label }
  } catch (error) {
    if (!(error instanceof LoupeError) || error.code !== 'not_idle') {
      throw error
    }
    return {
      kind: 'app',
      app,
      warning:
        "The app's screen never kept still, so loupe couldn't look for an overlay that the app draws itself, such as a menu or a sheet. If one shows, press back with the key command.",
    }
  }
}

/**
 * What is in front, from the top. loupe closes the shade and an "isn't
 * responding" dialog with no Back, so they come before the keyboard. Over
 * each other window the keyboard takes the first key. An app's dialog has
 * the title of the app's window, so only the window type tells them apart.
 */
async function frontOf(
  target: AndroidTarget,
  app: string | undefined,
  screen: Screen,
): Promise<Front> {
  const { focus, focusId } = screen.display
  if (!focus || !focusId) throw noFocus(target)

  const system = systemLayerOf(focus)
  if (system === 'notification-shade' || system === 'not-responding') {
    return { kind: 'layer', layer: system, window: focusId }
  }
  if (system) {
    return screen.keyboard === 'none'
      ? { kind: 'layer', layer: system, window: focusId }
      : keyboardFront(target, screen)
  }

  const window = await windowOf(target, focusId)
  const owner = window?.package ?? focus.split('/')[0] ?? focus
  if (app && owner !== app) throw otherInFront(target, app, focus)
  if (screen.keyboard !== 'none') return keyboardFront(target, screen)
  if (window?.type === 'APPLICATION') {
    return { kind: 'layer', layer: 'app-dialog', window: focusId }
  }
  if (window?.type === 'BASE_APPLICATION') return appFront(target, owner)
  throw unknownWindow(owner, window?.type)
}

/** Taps "Wait" in an "isn't responding" dialog, which has no app to check. */
async function tapWait(
  target: AndroidTarget,
  display: WindowDisplay,
): Promise<void> {
  const tree = await readWindowTree(target, display)
  const { point } = findElement(
    tree.nodes,
    { by: 'id', value: WAIT_BUTTON },
    tree.display.size,
    'loupe taps "Wait" only when the dialog has one.',
  )
  const { x, y } = onScreen(tree.display, point)
  await target.adb.run(['shell', 'input', 'tap', String(x), String(y)])
}

async function sendKey(target: AndroidTarget, key: string): Promise<void> {
  await target.adb.run(['shell', 'input', 'keyevent', key])
}

/** loupe closes these layers with no key. */
const CLOSED_WITHOUT_KEY = new Set<Layer>([
  'notification-shade',
  'not-responding',
  'stylus-sheet',
])

/**
 * Waits until the input dispatcher's focus is on the window in focus. Right
 * after a layer goes, the window manager moves its focus first and the input
 * dispatcher after it, so a key sent in between goes to the layer that is
 * closing (13 ms after the shade on a busy API 36 emulator). When `dumpsys
 * input` has no focus that loupe can read, it doesn't wait.
 */
async function untilInputFocus(
  target: AndroidTarget,
  front: LayerFront,
  { display }: Screen,
  { limit, interval }: Required<Omit<DismissOptions, 'all'>>,
): Promise<void> {
  if (!display.focusId) return
  const start = Date.now()
  for (;;) {
    const dump = await target.adb.text(['shell', 'dumpsys', 'input'])
    const focus = parseInputFocus(dump)
    if (focus === undefined || focus === display.focusId) return
    if (Date.now() - start >= limit) {
      throw new LoupeError(
        'timeout',
        `The input focus didn't move to ${LAYER_NAMES[front.layer]} within ${limit} ms, so loupe sent no key: it could reach another window. Try again in a moment.`,
      )
    }
    await sleep(interval)
  }
}

/**
 * Closes the layer in front. In Gboard's stylus mode, Back closes the
 * keyboard but also reaches the app, and doesn't close the stylus sheet;
 * Escape closes the keyboard only (round 9b, API 35 and 36).
 */
async function close(
  target: AndroidTarget,
  front: LayerFront,
  screen: Screen,
): Promise<DismissWay> {
  switch (front.layer) {
    case 'notification-shade':
      await target.adb.run(['shell', 'cmd', 'statusbar', 'collapse'])
      return 'collapse'
    case 'not-responding':
      await tapWait(target, screen.display)
      return 'tap-wait'
    case 'stylus-sheet': {
      const { x, y } = front.cancel
      await target.adb.run(['shell', 'input', 'tap', String(x), String(y)])
      return 'tap-cancel'
    }
    case 'keyboard':
      if (screen.keyboard === 'handwriting') {
        await sendKey(target, 'KEYCODE_ESCAPE')
        return 'escape'
      }
      await sendKey(target, 'KEYCODE_BACK')
      return 'back'
    default:
      await sendKey(target, 'KEYCODE_BACK')
      return 'back'
  }
}

/**
 * Whether the layer is gone: the keyboard's source hides; the stylus sheet
 * leaves the keyboard's window (the handwriting toolbar stays); an overlay
 * of the app no longer shows its label, or the app left the front; each
 * other layer's window loses the focus to another window.
 */
async function isGone(
  target: AndroidTarget,
  front: LayerFront,
  screen: Screen,
): Promise<boolean> {
  switch (front.layer) {
    case 'keyboard':
      return screen.keyboard === 'none'
    case 'stylus-sheet':
      return (
        screen.keyboard === 'none' ||
        !(await stylusSheetCancel(target, screen.display))
      )
    case 'app-overlay':
      try {
        return (await topOverlay(target, front.app)) !== front.label
      } catch (error) {
        if (!(error instanceof LoupeError)) throw error
        if (error.code === 'app_not_in_front') return true
        if (error.code === 'not_idle') return false
        throw error
      }
    default: {
      const { focusId } = screen.display
      return focusId !== undefined && focusId !== front.window
    }
  }
}

/** Reads the screen until the layer is gone, for up to `limit` ms. */
async function untilGone(
  target: AndroidTarget,
  front: LayerFront,
  { limit, interval }: Required<Omit<DismissOptions, 'all'>>,
): Promise<Screen | undefined> {
  const start = Date.now()
  for (;;) {
    const screen = await readScreen(target)
    if (await isGone(target, front, screen)) return screen
    if (Date.now() - start >= limit) return undefined
    await sleep(interval)
  }
}

/** The error, with the layers that loupe closed before it. */
function afterClosed(closed: readonly Closed[], error: unknown): unknown {
  if (closed.length === 0 || !(error instanceof LoupeError)) return error
  const list = closed.map(describeClosed).join(', then ')
  return new LoupeError(error.code, `loupe closed ${list}. ${error.message}`, {
    cause: error,
  })
}

/**
 * Closes the top layer over the app, or with `all` each layer up to
 * `MAX_LAYERS`. It sends no key when nothing is open, and none into a window
 * that it doesn't know: Back there could leave a screen of the app, or the
 * app. In the app's own window it closes only a labelled overlay
 * (`labelledOverlays`). A real device needs `app`.
 */
export async function dismissAndroid(
  target: AndroidTarget,
  app: string | undefined,
  { all = false, limit = 5000, interval = 250 }: DismissOptions = {},
): Promise<Dismissed> {
  requireAppOnDevice(target, app)
  const options = { limit, interval }
  const closed: Closed[] = []
  let screen = await readScreen(target)

  try {
    for (;;) {
      const front = await frontOf(target, app, screen)
      if (front.kind === 'app') {
        return {
          app: front.app,
          closed,
          ...(front.warning ? { warnings: [front.warning] } : {}),
        }
      }
      if (closed.length >= (all ? MAX_LAYERS : 1)) {
        return { app, closed, next: front.layer }
      }

      if (!CLOSED_WITHOUT_KEY.has(front.layer)) {
        await untilInputFocus(target, front, screen, options)
      }
      const start = Date.now()
      const way = await close(target, front, screen)
      const after = await untilGone(target, front, options)
      if (!after) {
        const name = LAYER_NAMES[front.layer]
        throw new LoupeError(
          'timeout',
          `${name[0]?.toUpperCase()}${name.slice(1)} still shows ${limit} ms after loupe tried to close it ${WAY_NAMES[way]}.`,
        )
      }
      closed.push({
        layer: front.layer,
        ...(front.layer === 'app-overlay' ? { label: front.label } : {}),
        way,
        ms: Date.now() - start,
      })
      screen = after
    }
  } catch (error) {
    throw afterClosed(closed, error)
  }
}
