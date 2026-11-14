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

async function readWindowDisplay(
  target: AndroidTarget,
): Promise<WindowDisplay> {
  const display = parseWindowDisplays(
    await target.adb.text(['shell', 'dumpsys', 'window', 'displays']),
  )
  if (!display) {
    throw new LoupeError(
      'tool_failed',
      `loupe can't read the display of ${target.serial} from "dumpsys window displays".`,
    )
  }
  return display
}

function toDisplayState(display: WindowDisplay): DisplayState {
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

function notTurned(
  display: WindowDisplay,
  wanted: Orientation,
  timeout: number,
): LoupeError {
  const now = orientationOf(display.rotation)
  const app = display.appOrientation
  if (app && !FOLLOWS_USER_ROTATION.has(app)) {
    return new LoupeError(
      'orientation_locked',
      `The screen stays ${now}, because the app in front sets its own orientation (${app}). Open an app that follows the rotation, then rotate again.`,
    )
  }
  return new LoupeError(
    'timeout',
    `The screen didn't turn to ${wanted} in ${timeout} ms. It's ${now}.`,
  )
}

/**
 * Locks the user rotation, then reads the screen back until it has turned.
 * An app can ask for its own orientation, and that wins over the user
 * rotation, so the setting alone proves nothing. The lock stays after loupe
 * exits, as when a person turns auto-rotate off.
 */
export async function rotateAndroid(
  target: AndroidTarget,
  orientation: Orientation,
  { timeout, interval = 250 }: RotateOptions,
): Promise<DisplayState> {
  const wanted = rotationOf(orientation)
  await setUserRotation(target, wanted)

  const deadline = Date.now() + timeout
  for (;;) {
    const display = await readWindowDisplay(target)
    if (display.rotation === wanted) return toDisplayState(display)
    if (Date.now() >= deadline) throw notTurned(display, orientation, timeout)
    await sleep(interval)
  }
}
