import { setTimeout as sleep } from 'node:timers/promises'
import {
  type DisplayState,
  type Orientation,
  orientationOf,
  rotationOf,
} from '../../core/display'
import { LoupeError } from '../../core/errors'
import { fromPixels } from '../../core/units'
import { type AndroidTarget } from './devices'
import { parseWindowDisplays, type WindowDisplay } from './parse'

/** App orientations that follow the user rotation. Each other one sets its own. */
const FOLLOWS_USER_ROTATION = new Set([
  'SCREEN_ORIENTATION_UNSET',
  'SCREEN_ORIENTATION_UNSPECIFIED',
  'SCREEN_ORIENTATION_USER',
  'SCREEN_ORIENTATION_FULL_USER',
  'SCREEN_ORIENTATION_BEHIND',
])

export interface RotateOptions {
  /** Milliseconds to wait for the screen to turn. */
  timeout: number
  /** Milliseconds between two reads. Default: 250. */
  interval?: number
}

export function dumpWindowDisplays(target: AndroidTarget): Promise<string> {
  return target.adb.text(['shell', 'dumpsys', 'window', 'displays'])
}

export async function readWindowDisplay(
  target: AndroidTarget,
): Promise<WindowDisplay> {
  return windowDisplayOf(target, await dumpWindowDisplays(target))
}

/** The display in a dump of `dumpsys window displays`. */
export function windowDisplayOf(
  target: AndroidTarget,
  dump: string,
): WindowDisplay {
  const display = parseWindowDisplays(dump)
  if (!display) {
    throw new LoupeError(
      'tool_failed',
      `loupe can't read the display of ${target.serial} from "dumpsys window displays".`,
    )
  }
  return display
}

export function toDisplayState(display: WindowDisplay): DisplayState {
  const scale = display.density / 160
  return {
    orientation: orientationOf(display.rotation),
    size: {
      width: fromPixels(display.current.width, scale),
      height: fromPixels(display.current.height, scale),
    },
    pixels: display.current,
    scale,
  }
}

export async function readAndroidDisplay(
  target: AndroidTarget,
): Promise<DisplayState> {
  return toDisplayState(await readWindowDisplay(target))
}

async function setUserRotation(
  target: AndroidTarget,
  rotation: number,
): Promise<void> {
  try {
    await target.adb.run([
      'shell',
      'wm',
      'user-rotation',
      'lock',
      `${rotation}`,
    ])
  } catch (error) {
    const unknownCommand =
      error instanceof LoupeError &&
      error.code === 'tool_failed' &&
      error.message.includes('Unknown command')
    if (!unknownCommand) throw error

    // Android 11 has no `wm user-rotation`. Auto-rotate goes off at each
    // rotate, because it can come back on.
    await target.adb.run([
      'shell',
      'settings',
      'put',
      'system',
      'accelerometer_rotation',
      '0',
    ])
    await target.adb.run([
      'shell',
      'settings',
      'put',
      'system',
      'user_rotation',
      `${rotation}`,
    ])
  }
}

function setsOwnOrientation({ appOrientation }: WindowDisplay): boolean {
  return (
    appOrientation !== undefined && !FOLLOWS_USER_ROTATION.has(appOrientation)
  )
}

function orientationLocked(display: WindowDisplay): LoupeError {
  return new LoupeError(
    'orientation_locked',
    `The app in front sets its own orientation (${display.appOrientation}), so loupe doesn't rotate now. The screen can't turn, and Android can undo the setting later. Open an app that follows the rotation, then rotate again.`,
  )
}

/**
 * Locks the user rotation, then reads the screen back until it has turned.
 * An app can ask for its own orientation, and that wins over the user
 * rotation, so the setting alone proves nothing.
 *
 * loupe writes nothing while such an app is in front. Android 14 and later
 * keep the user rotation while a `NOSENSOR` app (a launcher) is in front,
 * and put it back when that app leaves. A write in that time is lost, and
 * the read-back can match by chance: the launcher is in portrait.
 *
 * The lock stays after loupe exits, as when a person turns auto-rotate off.
 */
export async function rotateAndroid(
  target: AndroidTarget,
  orientation: Orientation,
  { timeout, interval = 250 }: RotateOptions,
): Promise<DisplayState> {
  const wanted = rotationOf(orientation)
  const before = await readWindowDisplay(target)
  if (setsOwnOrientation(before)) throw orientationLocked(before)
  await setUserRotation(target, wanted)

  const deadline = Date.now() + timeout
  for (;;) {
    const display = await readWindowDisplay(target)
    // Another app can come to the front during the wait.
    if (setsOwnOrientation(display)) throw orientationLocked(display)
    if (display.rotation === wanted) return toDisplayState(display)
    if (Date.now() >= deadline) {
      throw new LoupeError(
        'timeout',
        `The screen didn't turn to ${orientation} in ${timeout} ms. It's ${orientationOf(display.rotation)}.`,
      )
    }
    await sleep(interval)
  }
}
