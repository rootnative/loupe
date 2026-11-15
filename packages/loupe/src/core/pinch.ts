import { z } from 'zod'
import { ORIENTATIONS } from './display'
import { elementSchema } from './element'
import { LoupeError } from './errors'
import { describePoint, describeTouched, pointSchema } from './touch'
import { type Point, round2, type Size } from './units'

/** The input fields of the shape of a pinch. */
export const pinchFields = {
  scale: z
    .number()
    .positive()
    .default(1)
    .describe(
      'The span between the fingers at the end ÷ the span at the start. Above 1 spreads them (zoom in); below 1 brings them together (zoom out).',
    ),
  distance: z
    .number()
    .positive()
    .default(200)
    .describe(
      'The smaller span between the fingers, in dp: where a spread starts, or where a pinch ends. Android ignores a span under about 170 dp.',
    ),
  angle: z
    .number()
    .min(0)
    .max(180)
    .optional()
    .describe(
      'The line between the fingers at the start, in degrees clockwise from across the screen: 0 is across, 90 is down. Default: along the longer side of the screen.',
    ),
  turn: z
    .number()
    .default(0)
    .describe(
      'Degrees to turn the fingers around the centre during the gesture, clockwise. A negative value turns them the other way (on the CLI: --turn=-90).',
    ),
}

export interface PinchShape {
  /** In dp. */
  centre: Point
  scale: number
  distance: number
  angle?: number
  turn: number
}

export interface PinchPlan {
  angle: number
  /** In dp. */
  span: { from: number; to: number }
  /** The two fingers at each step, from the touch to the lift. In dp. */
  steps: [Point, Point][]
}

function stageOf(index: number, steps: number): string {
  if (index === 0) return 'at the start'
  return index === steps ? 'at the end' : 'during the gesture'
}

/**
 * The points of the two fingers in `steps` equal steps. The span and the
 * angle change at an even rate. Each finger must stay on the screen.
 */
export function planPinch(
  shape: PinchShape,
  screen: Size,
  steps: number,
): PinchPlan {
  const { centre, scale, distance, turn } = shape
  if (scale === 1 && turn === 0) {
    throw new LoupeError(
      'invalid_input',
      'A pinch needs a scale other than 1, a turn, or both.',
    )
  }
  const angle = shape.angle ?? (screen.height > screen.width ? 90 : 0)
  const from = distance * Math.max(1, 1 / scale)
  const to = from * scale

  const plan = Array.from({ length: steps + 1 }, (_, index): [Point, Point] => {
    const part = index / steps
    const half = (from + (to - from) * part) / 2
    const radians = ((angle + turn * part) * Math.PI) / 180
    const dx = half * Math.cos(radians)
    const dy = half * Math.sin(radians)
    return [
      { x: centre.x - dx, y: centre.y - dy },
      { x: centre.x + dx, y: centre.y + dy },
    ]
  })

  plan.forEach((fingers, index) => {
    const off = fingers.find(
      ({ x, y }) => x < 0 || y < 0 || x >= screen.width || y >= screen.height,
    )
    if (off) {
      throw new LoupeError(
        'invalid_input',
        `A finger leaves the screen ${stageOf(index, steps)}: it's at ${describePoint(off)} dp, and the screen is ${round2(screen.width)} × ${round2(screen.height)} dp. Use a smaller scale or distance, another angle, or a centre further from the edge.`,
      )
    }
  })

  return { angle, span: { from, to }, steps: plan }
}

export const pinchSchema = z.object({
  orientation: z.enum(ORIENTATIONS),
  centre: pointSchema.describe('The centre of the pinch, in dp.'),
  element: elementSchema
    .optional()
    .describe('The element that loupe pinched, when the input named one.'),
  fingers: z
    .array(z.object({ from: pointSchema, to: pointSchema }))
    .describe('Where each finger touched and where it lifted, in dp.'),
  span: z
    .object({ from: z.number(), to: z.number() })
    .describe(
      'The span between the fingers at the start and at the end, in dp.',
    ),
  scale: z.number(),
  angle: z
    .number()
    .describe(
      'The line between the fingers at the start, in degrees clockwise from across the screen.',
    ),
  turn: z.number().describe('In degrees, clockwise.'),
  duration: z.number().describe('In milliseconds.'),
  moveTime: z
    .number()
    .describe('Milliseconds that the move took, measured on the host.'),
})

export type Pinch = z.infer<typeof pinchSchema>

/** `Pinched (205.71, 457.14) dp in portrait: 200 → 400 dp apart; …` */
export function describePinch(pinch: Pinch): string {
  const { centre, element, span, turn, orientation, moveTime } = pinch
  const turned =
    turn === 0
      ? ''
      : `, turned ${round2(Math.abs(turn))}° ${turn > 0 ? 'clockwise' : 'counter-clockwise'}`
  return `Pinched ${describeTouched({ points: [centre], element })} dp in ${orientation}: ${round2(span.from)} → ${round2(span.to)} dp apart${turned}; the move took ${moveTime} ms`
}
