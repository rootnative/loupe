import { z } from 'zod'

/**
 * In the order of the rotation: each step turns the device a quarter turn
 * to the left (counter-clockwise), as Android counts `Surface.ROTATION_*`.
 */
export const ORIENTATIONS = [
  'portrait',
  'landscape-left',
  'portrait-upside-down',
  'landscape-right',
] as const

export type Orientation = (typeof ORIENTATIONS)[number]

export function orientationOf(rotation: number): Orientation {
  const orientation = ORIENTATIONS[rotation]
  if (!orientation) {
    throw new RangeError(`${rotation} isn't a rotation from 0 to 3.`)
  }
  return orientation
}

export function rotationOf(orientation: Orientation): number {
  return ORIENTATIONS.indexOf(orientation)
}

export const orientationDescription =
  'landscape-left: the device is turned to the left (counter-clockwise), so its top edge is on the left. landscape-right is the other way.'

const sizeSchema = z.object({ width: z.number(), height: z.number() })

export const displaySchema = z.object({
  orientation: z.enum(ORIENTATIONS).describe(orientationDescription),
  size: sizeSchema.describe(
    'The screen in the current orientation, in dp (pt on iOS).',
  ),
  pixels: sizeSchema.describe('The screen in the current orientation, in px.'),
  scale: z.number().describe('Pixels per dp (pt on iOS).'),
})

export type DisplayState = z.infer<typeof displaySchema>

function round(value: number): number {
  return Math.round(value * 100) / 100
}

/** One line for a person, with dp rounded to 2 places. */
export function describeDisplay({
  orientation,
  size,
  pixels,
  scale,
}: DisplayState): string {
  return `${orientation}: ${round(size.width)} × ${round(size.height)} dp (${pixels.width} × ${pixels.height} px, scale ${scale})`
}
