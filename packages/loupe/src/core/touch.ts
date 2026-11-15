import { z } from 'zod'
import { ORIENTATIONS } from './display'
import { type Point, round2 } from './units'

export const pointSchema = z.object({ x: z.number(), y: z.number() })

/** An input field for one coordinate of a point. */
export function coordinateField(axis: 'x' | 'y') {
  return z
    .number()
    .min(0)
    .describe(
      `${axis === 'x' ? 'Across' : 'Down'} from the top-left corner of the screen, in dp (pt on iOS), not px.`,
    )
}

export function durationField(byDefault: number, what: string) {
  return z
    .number()
    .int()
    .min(0)
    .default(byDefault)
    .describe(`Milliseconds ${what}.`)
}

export const touchSchema = z.object({
  orientation: z.enum(ORIENTATIONS),
  points: z.array(pointSchema).describe('The points of the touch, in dp.'),
  pixels: z
    .array(pointSchema)
    .describe('The same points in px, as loupe sent them.'),
  duration: z.number().optional().describe('In milliseconds.'),
})

export type Touch = z.infer<typeof touchSchema>

export function describePoint({ x, y }: Point): string {
  return `(${round2(x)}, ${round2(y)})`
}
