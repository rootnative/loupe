import { setTimeout as sleep } from 'node:timers/promises'
import { LoupeError } from '../../core/errors'
import { pngSize } from '../../core/png'
import { type Capture } from '../../core/screenshot'
import { type Size } from '../../core/units'
import { type AndroidTarget } from './devices'
import { toDisplayState } from './display'
import { whileInFront } from './foreground'

export interface CaptureOptions {
  /** Milliseconds to wait for the pixels to turn with the display. Default: 5000. */
  timeout?: number
  /** Milliseconds between two captures. Default: 250. */
  interval?: number
}

function isLandscape({ width, height }: Size): boolean {
  return width > height
}

/**
 * Takes the screen as a PNG, only while `app` is in front (see
 * `whileInFront`). `screencap` gives it upright in each orientation, so
 * loupe doesn't turn it.
 *
 * Right after a rotate, the window manager can give the new rotation while
 * `screencap` still gives the old pixels: on a busy emulator, for about a
 * second. So loupe takes the screen again until the PNG has the orientation
 * of the display, for up to `timeout` ms.
 */
export async function captureAndroid(
  target: AndroidTarget,
  app?: string,
  { timeout = 5000, interval = 250 }: CaptureOptions = {},
): Promise<Capture> {
  const deadline = Date.now() + timeout
  for (;;) {
    const { value: png, display } = await whileInFront(target, app, () =>
      target.adb.run(['exec-out', 'screencap', '-p']),
    )
    const pixels = pngSize(png)
    if (!pixels) {
      throw new LoupeError(
        'tool_failed',
        `screencap on ${target.serial} didn't give a PNG.`,
      )
    }
    if (isLandscape(pixels) === isLandscape(display.current)) {
      return { png, pixels, display: toDisplayState(display) }
    }
    if (Date.now() >= deadline) {
      throw new LoupeError(
        'timeout',
        `The screen is ${display.current.width} × ${display.current.height} px, but screencap still gave ${pixels.width} × ${pixels.height} px after ${timeout} ms. The screen is still turning. Wait until it's still, then try again.`,
      )
    }
    await sleep(interval)
  }
}
