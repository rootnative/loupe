import { LoupeError } from '../../core/errors'
import { type AndroidTarget } from './devices'
import { readWindowDisplay } from './display'
import { type WindowDisplay } from './parse'

/**
 * True when the window title belongs to the app. The window of an activity
 * has the title `<package>/<activity>`, and a window with no title shows the
 * package alone. Each other title gives false, for example
 * `NotificationShade` or `PopupWindow:1a2b3c`.
 */
export function isAppWindow(title: string | undefined, app: string): boolean {
  if (!title) return false
  const slash = title.indexOf('/')
  return (slash === -1 ? title : title.slice(0, slash)) === app
}

export interface InFront<T> {
  value: T
  /** Read before `take`, while the app was in front. */
  display: WindowDisplay
}

function notInFront(
  target: AndroidTarget,
  app: string,
  display: WindowDisplay,
): LoupeError {
  // On a real device, the name of the other app is the user's data.
  const where =
    target.kind === 'device'
      ? ''
      : display.focus
        ? ` The focus is on ${display.focus}.`
        : ' No window has the focus: the screen can be off or locked.'
  return new LoupeError(
    'app_not_in_front',
    `${app} isn't in front, so loupe does nothing on ${target.serial}.${where} Open ${app}, then try again.`,
  )
}

/** A real device needs `app`, because it can show the user's other apps. */
export function requireAppOnDevice(
  target: AndroidTarget,
  app: string | undefined,
): void {
  if (!app && target.kind === 'device') {
    throw new LoupeError(
      'invalid_input',
      `${target.serial} is a real device, so loupe needs the "app" option: the package of the app under test. Then loupe works only while that app is in front.`,
    )
  }
}

/**
 * Reads the display, and checks that `app` is in front (see
 * `requireAppOnDevice`). On an emulator with no `app`, there's no check.
 */
export async function readInFront(
  target: AndroidTarget,
  app: string | undefined,
): Promise<WindowDisplay> {
  requireAppOnDevice(target, app)
  const display = await readWindowDisplay(target)
  if (app && !isAppWindow(display.focus, app)) {
    throw notInFront(target, app, display)
  }
  return display
}

/**
 * Runs `take` only while `app` is in front (see `readInFront`), then checks
 * the focus again, so a capture can't hold the screen of another app.
 */
export async function whileInFront<T>(
  target: AndroidTarget,
  app: string | undefined,
  take: () => Promise<T>,
): Promise<InFront<T>> {
  const display = await readInFront(target, app)
  const value = await take()

  if (app && !isAppWindow((await readWindowDisplay(target)).focus, app)) {
    throw new LoupeError(
      'app_not_in_front',
      `The focus moved away from ${app} during the capture, so loupe dropped it. Open ${app}, then try again.`,
    )
  }
  return { value, display }
}
