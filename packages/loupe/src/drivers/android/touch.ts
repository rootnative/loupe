import { type DisplayState } from '../../core/display'
import { LoupeError } from '../../core/errors'
import { DEFAULT_TIMEOUT_MS } from '../../core/exec'
import { type Touch } from '../../core/touch'
import { type Point, round2 } from '../../core/units'
import { type AndroidTarget } from './devices'
import { toDisplayState } from './display'
import { readInFront } from './foreground'

/** The point in px of the current orientation. A point off the screen fails. */
function onScreen(display: DisplayState, point: Point): Point {
  const { width, height } = display.pixels
  const x = point.x * display.scale
  const y = point.y * display.scale
  if (x < 0 || y < 0 || x >= width || y >= height) {
    throw new LoupeError(
      'invalid_input',
      `(${point.x}, ${point.y}) is off the screen, which is ${round2(display.size.width)} × ${round2(display.size.height)} dp in ${display.orientation}. Points are in dp, not px.`,
    )
  }
  // Whole px work with each version of `input`. A point less than half a
  // px from the edge rounds onto the edge, so the last px is the limit.
  return {
    x: Math.min(Math.round(x), width - 1),
    y: Math.min(Math.round(y), height - 1),
  }
}

/**
 * Checks that the app is in front, then sends one `input` command with the
 * points in px. There's no check after the touch: a tap can open another app
 * on purpose. `input` returns after Android has delivered the last event.
 */
async function touch(
  target: AndroidTarget,
  app: string | undefined,
  points: readonly Point[],
  send: (pixels: readonly Point[]) => (string | number)[],
  duration?: number,
): Promise<Touch> {
  const display = toDisplayState(await readInFront(target, app))
  const pixels = points.map((point) => onScreen(display, point))

  await target.adb.run(['shell', 'input', ...send(pixels).map(String)], {
    timeout: (duration ?? 0) + DEFAULT_TIMEOUT_MS,
  })
  return {
    orientation: display.orientation,
    points: [...points],
    pixels,
    duration,
  }
}

function flat(pixels: readonly Point[]): number[] {
  return pixels.flatMap(({ x, y }) => [x, y])
}

export function tapAndroid(
  target: AndroidTarget,
  at: Point,
  app?: string,
): Promise<Touch> {
  return touch(target, app, [at], (pixels) => ['tap', ...flat(pixels)])
}

/** A swipe that doesn't move: Android sees a long press. */
export function holdAndroid(
  target: AndroidTarget,
  at: Point,
  duration: number,
  app?: string,
): Promise<Touch> {
  return touch(
    target,
    app,
    [at],
    (pixels) => ['swipe', ...flat(pixels), ...flat(pixels), duration],
    duration,
  )
}

export function swipeAndroid(
  target: AndroidTarget,
  from: Point,
  to: Point,
  duration: number,
  app?: string,
): Promise<Touch> {
  return touch(
    target,
    app,
    [from, to],
    (pixels) => ['swipe', ...flat(pixels), duration],
    duration,
  )
}
