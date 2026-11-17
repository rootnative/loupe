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
    .enum(['probe', 'dumpsys'])
    .describe(
      'Where the safe area comes from: "probe" is the app\'s own numbers, from the <LoupeProbe /> on the screen; "dumpsys" is the system\'s. The system bars and the cutout always come from the system.',
    ),
  safeArea: insetsSchema.describe(
    "Per edge, in dp: what a safe-area view gets. From the app's probe, or else the system bars and the cutout together.",
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

export const EDGES = ['top', 'right', 'bottom', 'left'] as const

export type Edge = (typeof EDGES)[number]

/** The edges where `a` and `b` are more than `tolerance` apart. */
export function differingEdges(
  a: Insets,
  b: Insets,
  tolerance: number,
): Edge[] {
  return EDGES.filter((edge) => Math.abs(a[edge] - b[edge]) > tolerance)
}

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
