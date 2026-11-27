import { type Orientation } from '../../core/display'
import { LoupeError } from '../../core/errors'
import { encodePng, pngSize, turnQuarter } from '../../core/png'
import { type Capture, decodeCapture } from '../../core/screenshot'
import { fromPixels } from '../../core/units'
import { type IosTarget } from '../select'
import { type RunnerClient } from './runner-client'

/** A screenshot comes as base64 in one answer, so it gets more time. */
const SHOT_TIMEOUT_MS = 60_000

/**
 * The orientation of the device, as XCUITest names it. A simulator that
 * never turned says `unknown`, and is in portrait. `faceUp` and `faceDown`
 * say nothing about the screen, so they count as portrait too.
 */
function orientationOf(name: unknown): Orientation {
  switch (name) {
    case 'landscapeLeft':
      return 'landscape-left'
    case 'landscapeRight':
      return 'landscape-right'
    case 'portraitUpsideDown':
      return 'portrait-upside-down'
  }
  return 'portrait'
}

/** Fails with `app_not_in_front` unless the app runs in front. */
async function requireInFront(
  runner: RunnerClient,
  target: IosTarget,
  app: string,
): Promise<void> {
  const { state } = await runner.request({ cmd: 'state', app })
  if (state !== 'runningForeground') {
    throw new LoupeError(
      'app_not_in_front',
      `${app} isn't in front of ${target.name}: its state is ${String(state)}. Open it, then try again.`,
    )
  }
}

/**
 * Takes the screen of the simulator as an upright PNG, through its runner.
 * With `app`, only while that app runs in front, checked before and after.
 *
 * XCUITest gives the pixels in the order of the portrait screen in each
 * orientation. So in landscape loupe turns the image: to the left for
 * `landscape-left`, where the top of the screen is at the right edge of the
 * pixels, and to the right for `landscape-right`.
 */
export async function captureIos(
  runner: RunnerClient,
  target: IosTarget,
  app?: string,
): Promise<Capture> {
  if (app) await requireInFront(runner, target, app)
  const device = await runner.request({ cmd: 'orientation' })
  const shot = await runner.request(
    { cmd: 'screenshot' },
    { timeout: SHOT_TIMEOUT_MS },
  )
  if (app) await requireInFront(runner, target, app)

  const orientation = orientationOf(device.orientation)
  const scale = typeof shot.scale === 'number' ? shot.scale : 0
  let png: Buffer = Buffer.from(
    typeof shot.png === 'string' ? shot.png : '',
    'base64',
  )
  if (orientation === 'landscape-left' || orientation === 'landscape-right') {
    png = encodePng(
      turnQuarter(
        decodeCapture(png),
        orientation === 'landscape-left' ? 'left' : 'right',
      ),
    )
  }
  const pixels = pngSize(png)
  if (!pixels || scale <= 0) {
    throw new LoupeError(
      'tool_failed',
      `The iOS runner on ${target.name} didn't give a PNG and the scale of the screen.`,
    )
  }
  return {
    png,
    pixels,
    display: {
      orientation,
      size: {
        width: fromPixels(pixels.width, scale),
        height: fromPixels(pixels.height, scale),
      },
      pixels,
      scale,
    },
  }
}
