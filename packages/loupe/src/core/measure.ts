import { z } from 'zod'
import { type Selector } from './element'
import { LoupeError } from './errors'
import { insetsSchema } from './insets'
import { type Image } from './png'
import { pointSchema } from './touch'
import { type Insets, type Rect, rectCentre, round2, type Size } from './units'

export type Axis = 'row' | 'column'

export type MeasureTarget =
  | { line: { axis: Axis; at: number }; selector?: undefined }
  | { line?: undefined; selector: Selector }

interface MeasureInput {
  row?: number
  column?: number
  text?: string
  label?: string
  id?: string
}

/** The line or the element that the input names. It must name one. */
export function measureTargetOf(input: MeasureInput): MeasureTarget {
  const targets: MeasureTarget[] = [
    ...(input.row === undefined
      ? []
      : [{ line: { axis: 'row', at: input.row } } as const]),
    ...(input.column === undefined
      ? []
      : [{ line: { axis: 'column', at: input.column } } as const]),
    ...(['text', 'label', 'id'] as const).flatMap((by) => {
      const value = input[by]
      return value === undefined ? [] : [{ selector: { by, value } }]
    }),
  ]
  const [target] = targets
  if (target && targets.length === 1) return target
  throw new LoupeError(
    'invalid_input',
    'Name one thing to measure: a row, a column, or one of text, label and id.',
  )
}

/** A run of one colour along a line, in px; `end` is past the last pixel. */
export interface PixelRun {
  start: number
  end: number
  /** `#rrggbb`, or `#rrggbbaa` when not opaque. None: a mix of short runs. */
  colour?: string
}

function hex(values: readonly number[]): string {
  const [red = 0, green = 0, blue = 0, alpha = 255] = values
  const parts = alpha === 255 ? [red, green, blue] : [red, green, blue, alpha]
  return `#${parts.map((value) => value.toString(16).padStart(2, '0')).join('')}`
}

/**
 * The runs of one colour along a row or a column of the image. A pixel
 * joins the run when no channel differs from the run's first pixel by more
 * than `tolerance`. Each run gets the mean colour of its pixels. The runs
 * cover the whole line.
 */
export function colourRuns(
  image: Image,
  axis: Axis,
  index: number,
  tolerance: number,
): PixelRun[] {
  const length = axis === 'row' ? image.width : image.height
  const offsetOf = (position: number) =>
    (axis === 'row'
      ? index * image.width + position
      : position * image.width + index) * 4

  const runs: PixelRun[] = []
  let start = 0
  let first = offsetOf(0)
  const sums = [0, 0, 0, 0]
  const close = (end: number) => {
    const count = end - start
    runs.push({
      start,
      end,
      colour: hex(sums.map((sum) => Math.round(sum / count))),
    })
    sums.fill(0)
  }

  for (let position = 0; position < length; position += 1) {
    const at = offsetOf(position)
    let same = true
    for (let channel = 0; channel < 4 && same; channel += 1) {
      same =
        Math.abs(image.data[at + channel]! - image.data[first + channel]!) <=
        tolerance
    }
    if (!same) {
      close(position)
      start = position
      first = at
    }
    for (let channel = 0; channel < 4; channel += 1) {
      sums[channel] = sums[channel]! + image.data[at + channel]!
    }
  }
  close(length)
  return runs
}

/**
 * Joins each sequence of two or more runs shorter than `minLength` px into
 * one run with no colour: text and edges make many short runs. A short run
 * alone between two longer runs keeps its colour, as a thin line does.
 */
export function joinShortRuns(
  runs: readonly PixelRun[],
  minLength: number,
): PixelRun[] {
  const out: PixelRun[] = []
  let group: PixelRun[] = []
  const flush = () => {
    const [first] = group
    const last = group.at(-1)
    if (first && last) {
      out.push(
        group.length === 1 ? first : { start: first.start, end: last.end },
      )
    }
    group = []
  }
  for (const run of runs) {
    if (run.end - run.start < minLength) {
      group.push(run)
    } else {
      flush()
      out.push(run)
    }
  }
  flush()
  return out
}

export const runSchema = z.object({
  from: z.number().describe('The start along the line, in dp.'),
  to: z.number().describe('The end along the line, in dp.'),
  length: z.number().describe('In dp.'),
  pixels: z
    .object({ from: z.number(), to: z.number() })
    .describe('The same run in px: from the first pixel to past the last.'),
  colour: z
    .string()
    .optional()
    .describe(
      'The mean colour: #rrggbb, or #rrggbbaa when not opaque. Left out for a mix of short runs, for example text.',
    ),
})

export type Run = z.infer<typeof runSchema>

export function runInDp(run: PixelRun, scale: number): Run {
  return {
    from: run.start / scale,
    to: run.end / scale,
    length: (run.end - run.start) / scale,
    pixels: { from: run.start, to: run.end },
    colour: run.colour,
  }
}

export const lineSchema = z.object({
  axis: z.enum(['row', 'column']),
  at: z
    .number()
    .describe('The row (y) or the column (x) in dp, at the whole pixel used.'),
  pixel: z.number().describe('The row or the column in px.'),
  runs: z.array(runSchema),
})

export const elementMeasureSchema = z.object({
  toScreen: insetsSchema.describe(
    'From each edge of the screen to the element, in dp.',
  ),
  toSafeArea: insetsSchema.describe(
    'From each edge of the safe area to the element, in dp. Negative: the element reaches into the inset by that much.',
  ),
  offCentre: z
    .object({
      screen: pointSchema,
      safeArea: pointSchema,
    })
    .describe(
      "From the centre of the screen, and from the centre of the safe area, to the element's centre, in dp. Positive x is to the right, positive y is down.",
    ),
})

export type ElementMeasure = z.infer<typeof elementMeasureSchema>

/** Where a frame sits on the screen and in the safe area, all in dp. */
export function measureFrame(
  frame: Rect,
  screen: Size,
  safeArea: Insets,
): ElementMeasure {
  const right = screen.width - frame.x - frame.width
  const bottom = screen.height - frame.y - frame.height
  const safe = {
    x: safeArea.left,
    y: safeArea.top,
    width: screen.width - safeArea.left - safeArea.right,
    height: screen.height - safeArea.top - safeArea.bottom,
  }
  const centre = rectCentre(frame)
  const offset = (rect: Rect) => ({
    x: centre.x - rectCentre(rect).x,
    y: centre.y - rectCentre(rect).y,
  })
  return {
    toScreen: { top: frame.y, right, bottom, left: frame.x },
    toSafeArea: {
      top: frame.y - safeArea.top,
      right: right - safeArea.right,
      bottom: bottom - safeArea.bottom,
      left: frame.x - safeArea.left,
    },
    offCentre: {
      screen: offset({ x: 0, y: 0, ...screen }),
      safeArea: offset(safe),
    },
  }
}

/** One line for a person: a run, with dp rounded to 2 places. */
export function describeRun({ from, to, length, colour }: Run): string {
  return `${round2(from)}–${round2(to)} dp (${round2(length)} dp): ${colour ?? 'mixed'}`
}
