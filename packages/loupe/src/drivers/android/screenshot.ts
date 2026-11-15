import { type DisplayState } from '../../core/display'
import { LoupeError } from '../../core/errors'
import { pngSize } from '../../core/png'
import { type Size } from '../../core/units'
import { type AndroidTarget } from './devices'
import { readAndroidDisplay } from './display'

export interface Capture {
  png: Buffer
  /** The size of the PNG, from its header. */
  pixels: Size
  /** Read just before the capture. */
  display: DisplayState
}

/**
 * Takes the screen as a PNG. `screencap` gives it upright in each
 * orientation, so loupe doesn't turn it. A real device can show the user's
 * other apps, so it waits for a check of the app in front.
 */
export async function captureAndroid(target: AndroidTarget): Promise<Capture> {
  if (target.kind === 'device') {
    throw new LoupeError(
      'unsupported',
      `loupe doesn't take screenshots of a real device yet, because the screen can show your other apps. Use an emulator.`,
    )
  }

  const display = await readAndroidDisplay(target)
  const png = await target.adb.run(['exec-out', 'screencap', '-p'])
  const pixels = pngSize(png)
  if (!pixels) {
    throw new LoupeError(
      'tool_failed',
      `screencap on ${target.serial} didn't give a PNG.`,
    )
  }
  return { png, pixels, display }
}
