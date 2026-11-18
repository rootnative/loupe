import { setTimeout as sleep } from 'node:timers/promises'
import { findElement } from '../../core/element'
import { LoupeError } from '../../core/errors'
import { type AndroidTarget } from './devices'
import { dumpWindowDisplays, windowDisplayOf } from './display'
import { requireAppOnDevice } from './foreground'
import {
  parseWindowInsets,
  parseWindowList,
  type WindowDisplay,
  type WindowEntry,
} from './parse'
import { onScreen } from './touch'
import { readWindowTree } from './ui'

/**
 * The layers that `dismiss` closes: the keyboard, a dialog or a modal of the
 * app, the system share sheet, the permission dialog, the notification shade
 * (also with the quick settings open), and an "isn't responding" dialog.
 */
export const LAYERS = [
  'keyboard',
  'app-dialog',
  'share-sheet',
  'permission-dialog',
  'notification-shade',
  'not-responding',
] as const

export type Layer = (typeof LAYERS)[number]

/**
 * How loupe closes a layer. `back`: the Back key. `collapse`: `cmd statusbar
 * collapse`, which closes the shade and the quick settings in one step; Back
 * closes only one level of the quick settings. `tap-wait`: a tap on "Wait"
 * in an "isn't responding" dialog, so the app gets more time.
 */
export const DISMISS_WAYS = ['back', 'collapse', 'tap-wait'] as const

export type DismissWay = (typeof DISMISS_WAYS)[number]

/** The most layers that one call closes, with `all`. */
export const MAX_LAYERS = 5

export interface Closed {
  layer: Layer
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
  'app-dialog': "the app's dialog",
  'share-sheet': 'the share sheet',
  'permission-dialog': 'the permission dialog',
  'notification-shade': 'the notification shade',
  'not-responding': `the "isn't responding" dialog`,
}

const WAY_NAMES: Record<DismissWay, string> = {
  back: 'with Back',
  collapse: 'with a status bar collapse',
  'tap-wait': 'with a tap on Wait',
}

/** For a person, with no capital: `the share sheet`. */
export function describeLayer(layer: Layer): string {
  return LAYER_NAMES[layer]
}

/** For a person: `the share sheet with Back (152 ms)`. */
export function describeClosed({ layer, way, ms }: Closed): string {
  return `${LAYER_NAMES[layer]} ${WAY_NAMES[way]} (${ms} ms)`
}

const SHARE_SHEET_PACKAGES = new Set(['android', 'com.android.intentresolver'])
const NOT_RESPONDING = 'Application Not Responding: '
const IME_TYPES = new Set(['ime', 'ITYPE_IME'])
const WAIT_BUTTON = 'android:id/aerr_wait'

/**
 * The layer of a system window, from the title of the focus: the share
 * sheet is a `ChooserActivity…` of `android` up to API 33 and of the intent
 * resolver from API 34; the permission dialog is the
 * `GrantPermissionsActivity` of the permission controller.
 */
export function systemLayerOf(title: string): Layer | undefined {
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

interface Screen {
  display: WindowDisplay
  /** The keyboard has no window in focus: its inset source shows it. */
  keyboard: boolean
}

type Front =
  | { kind: 'layer'; layer: Layer; window?: string }
  | { kind: 'app'; app: string }

type LayerFront = Extract<Front, { kind: 'layer' }>

const KEYBOARD: LayerFront = { kind: 'layer', layer: 'keyboard' }

async function readScreen(target: AndroidTarget): Promise<Screen> {
  const dump = await dumpWindowDisplays(target)
  const sources = parseWindowInsets(dump)?.sources ?? []
  return {
    display: windowDisplayOf(target, dump),
    keyboard: sources.some(
      ({ type, visible, frame }) =>
        IME_TYPES.has(type) && visible && frame.width > 0 && frame.height > 0,
    ),
  }
}

async function windowOf(
  target: AndroidTarget,
  id: string,
): Promise<WindowEntry | undefined> {
  const dump = await target.adb.text(['shell', 'dumpsys', 'window', 'windows'])
  return parseWindowList(dump).find((window) => window.id === id)
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

/**
 * What is in front, from the top. loupe closes the shade and an "isn't
 * responding" dialog with no Back, so they come before the keyboard. Over
 * each other window the keyboard takes the first Back. An app's dialog has
 * the title of the app's window, so only the window type tells them apart.
 */
async function frontOf(
  target: AndroidTarget,
  app: string | undefined,
  { display, keyboard }: Screen,
): Promise<Front> {
  const { focus, focusId } = display
  if (!focus || !focusId) throw noFocus(target)

  const system = systemLayerOf(focus)
  if (system === 'notification-shade' || system === 'not-responding') {
    return { kind: 'layer', layer: system, window: focusId }
  }
  if (system) {
    return keyboard
      ? KEYBOARD
      : { kind: 'layer', layer: system, window: focusId }
  }

  const window = await windowOf(target, focusId)
  const owner = window?.package ?? focus.split('/')[0] ?? focus
  if (app && owner !== app) throw otherInFront(target, app, focus)
  if (keyboard) return KEYBOARD
  if (window?.type === 'APPLICATION') {
    return { kind: 'layer', layer: 'app-dialog', window: focusId }
  }
  if (window?.type === 'BASE_APPLICATION') return { kind: 'app', app: owner }
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
    default:
      await target.adb.run(['shell', 'input', 'keyevent', 'KEYCODE_BACK'])
      return 'back'
  }
}

/**
 * Reads the screen until the layer is gone, for up to `limit` ms: the
 * keyboard's source hides; each other layer's window loses the focus to
 * another window.
 */
async function untilGone(
  target: AndroidTarget,
  front: LayerFront,
  { limit, interval }: Required<Omit<DismissOptions, 'all'>>,
): Promise<Screen | undefined> {
  const start = Date.now()
  for (;;) {
    const screen = await readScreen(target)
    const { focusId } = screen.display
    const gone =
      front.layer === 'keyboard'
        ? !screen.keyboard
        : focusId !== undefined && focusId !== front.window
    if (gone) return screen
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
 * app. A real device needs `app`.
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
      if (front.kind === 'app') return { app: front.app, closed }
      if (closed.length >= (all ? MAX_LAYERS : 1)) {
        return { app, closed, next: front.layer }
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
      closed.push({ layer: front.layer, way, ms: Date.now() - start })
      screen = after
    }
  } catch (error) {
    throw afterClosed(closed, error)
  }
}
