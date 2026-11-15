import { type Pinch, type PinchShape, planPinch } from '../../core/pinch'
import { type Point, pointToPixels } from '../../core/units'
import { consoleGesture, needsConsole, toRaw } from './console'
import { type AndroidTarget } from './devices'
import { onScreen, screenInFront } from './touch'

const PINCH_STEPS = 10

export interface PinchOptions extends Omit<PinchShape, 'centre'> {
  /** Milliseconds for the move, at the least. */
  duration: number
}

/**
 * Two fingers through the emulator console: `input` has no second finger.
 * The guard runs before the touch, as for the other touches.
 */
export async function pinchAndroid(
  target: AndroidTarget,
  centre: Point,
  options: PinchOptions,
  app?: string,
): Promise<Omit<Pinch, 'element'>> {
  needsConsole(target, 'A pinch')
  const display = await screenInFront(target, app)
  onScreen(display, centre)
  const { angle, span, steps } = planPinch(
    { ...options, centre },
    display.size,
    PINCH_STEPS,
  )

  const moveTime = await consoleGesture(
    target,
    steps.map((fingers) =>
      fingers.map((finger) =>
        toRaw(pointToPixels(finger, display.scale), display),
      ),
    ),
    options.duration / PINCH_STEPS,
  )

  const first = steps[0] ?? []
  const last = steps.at(-1) ?? []
  return {
    orientation: display.orientation,
    centre,
    fingers: first.map((from, index) => ({ from, to: last[index] ?? from })),
    span,
    scale: options.scale,
    angle,
    turn: options.turn,
    duration: options.duration,
    moveTime,
  }
}
