import { type DisplayState } from '../../core/display'
import { LoupeError } from '../../core/errors'
import { pngSize } from '../../core/png'
import { type Size } from '../../core/units'
import { type AndroidTarget } from './devices'
import { toDisplayState } from './display'
import { whileInFront } from './foreground'

export interface Capture {
  png: Buffer
  /** The size of the PNG, from its header. */
  pixels: Size
  /** Read just before the capture. */
  display: DisplayState
}

/**
 * Takes the screen as a PNG, only while `app` is in front (see
 * `whileInFront`). `screencap` gives it upright in each orientation, so
 * loupe doesn't turn it.
 */
export async function captureAndroid(
  target: AndroidTarget,
  app?: string,
): Promise<Capture> {
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
  return { png, pixels, display: toDisplayState(display) }
}
