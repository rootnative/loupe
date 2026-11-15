import { z } from 'zod'
import { displaySchema } from './display'
import { rectSchema } from './ui'
import { type Insets, round2 } from './units'

export const insetsSchema = z.object({
  top: z.number(),
  right: z.number(),
  bottom: z.number(),
  left: z.number(),
})

export const insetsReadingSchema = displaySchema.extend({
  source: z
    .enum(['dumpsys'])
    .describe('Where the numbers come from: the system, not the app.'),
  safeArea: insetsSchema.describe(
    'The system bars and the cutout together, per edge, in dp: what a safe-area view gets.',
  ),
  systemBars: insetsSchema.describe(
    'The status bar and the navigation bar, per edge, in dp.',
  ),
  cutout: insetsSchema.describe('The cutout, per edge, in dp.'),
  cutoutRects: z
    .array(rectSchema)
    .describe('The cutout shapes as rectangles, in dp. Empty with no cutout.'),
  warnings: z.array(z.string()),
})

export type InsetsReading = z.infer<typeof insetsReadingSchema>

export const NO_INSETS: Insets = { top: 0, right: 0, bottom: 0, left: 0 }

/** The larger value of each edge. */
export function maxInsets(list: readonly Insets[]): Insets {
  return list.reduce(
    (all, insets) => ({
      top: Math.max(all.top, insets.top),
      right: Math.max(all.right, insets.right),
      bottom: Math.max(all.bottom, insets.bottom),
      left: Math.max(all.left, insets.left),
    }),
    NO_INSETS,
  )
}

export function describeInsets({ top, right, bottom, left }: Insets): string {
  return `top ${round2(top)}, right ${round2(right)}, bottom ${round2(bottom)}, left ${round2(left)} dp`
}
