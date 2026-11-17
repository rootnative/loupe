import { z } from 'zod'
import { defineCommand } from '../core/command'
import { appField, deviceField } from '../core/device'
import { describeDisplay, displaySchema } from '../core/display'
import {
  describeElement,
  elementSchema,
  findElement,
  selectorFields,
} from '../core/element'
import { LoupeError } from '../core/errors'
import { describeInsets } from '../core/insets'
import {
  colourRuns,
  describeRun,
  elementMeasureSchema,
  joinShortRuns,
  lineSchema,
  measureFrame,
  measureTargetOf,
  runInDp,
} from '../core/measure'
import { decodeCapture } from '../core/screenshot'
import { round2 } from '../core/units'
import { selectAndroidDevice } from '../drivers/android/devices'
import { insetsOfUi } from '../drivers/android/insets'
import { captureAndroid } from '../drivers/android/screenshot'
import { readAndroidUi } from '../drivers/android/ui'

const DEFAULT_TOLERANCE = 8
const DEFAULT_MIN_LENGTH = 1

const lineField = (axis: 'row' | 'column', coordinate: 'x' | 'y') =>
  z
    .number()
    .min(0)
    .optional()
    .describe(
      `Measure the colour runs along this ${axis} of a new screenshot: ${coordinate} in dp, from the top-left corner.`,
    )

export const measureCommand = defineCommand({
  name: 'measure',
  summary:
    'Measure the colour runs along a row or a column, or where an element sits on the screen and in the safe area',
  input: z.object({
    row: lineField('row', 'y'),
    column: lineField('column', 'x'),
    text: selectorFields.text.describe(
      'Measure the element with this text: the whole text, not a part.',
    ),
    label: selectorFields.label.describe(
      'Measure the element with this accessibility label (content-desc on Android).',
    ),
    id: selectorFields.id.describe(
      'Measure the element with this id: the resource-id on Android, or the part after ":id/".',
    ),
    tolerance: z
      .number()
      .int()
      .min(0)
      .max(255)
      .optional()
      .describe(
        `For a row or a column: a pixel stays in the run while no colour channel differs from the run's first pixel by more than this (0–255). ${DEFAULT_TOLERANCE} by default.`,
      ),
    minLength: z
      .number()
      .min(0)
      .optional()
      .describe(
        `For a row or a column, in dp: two or more runs in a row that are each shorter than this become one run with no colour, for example text. ${DEFAULT_MIN_LENGTH} by default; 0 keeps each run.`,
      ),
    app: appField,
    device: deviceField,
  }),
  output: displaySchema.extend({
    line: lineSchema
      .optional()
      .describe(
        'The colour runs, from the left or the top. They cover the whole line.',
      ),
    element: elementSchema
      .extend(elementMeasureSchema.shape)
      .extend({
        safeAreaSource: z
          .enum(['probe', 'dumpsys'])
          .describe('Where the safe area comes from, as in `insets`.'),
      })
      .optional(),
    warnings: z.array(z.string()),
  }),
  run: async (input, context) => {
    const { tolerance = DEFAULT_TOLERANCE, minLength = DEFAULT_MIN_LENGTH } =
      input
    const measured = measureTargetOf(input)
    const target = await selectAndroidDevice(context, input.device)

    if (measured.line) {
      const { axis, at } = measured.line
      const { png, display } = await captureAndroid(target, input.app)
      const image = decodeCapture(png)
      const pixel = Math.round(at * display.scale)
      const length = axis === 'row' ? image.height : image.width
      if (pixel >= length) {
        throw new LoupeError(
          'invalid_input',
          `The ${axis} ${at} dp isn't on the screen: it ends at ${round2(length / display.scale)} dp in ${display.orientation}.`,
        )
      }
      const runs = joinShortRuns(
        colourRuns(image, axis, pixel, tolerance),
        minLength * display.scale,
      )
      return {
        ...display,
        line: {
          axis,
          at: pixel / display.scale,
          pixel,
          runs: runs.map((run) => runInDp(run, display.scale)),
        },
        warnings: [],
      }
    }

    const ui = await readAndroidUi(target, input.app)
    const { element } = findElement(
      ui.nodes,
      measured.selector,
      ui.display.size,
      'Measure one by another selector.',
    )
    const insets = await insetsOfUi(target, ui)
    return {
      ...ui.display,
      element: {
        ...element,
        ...measureFrame(element.frame, ui.display.size, insets.safeArea),
        safeAreaSource: insets.source,
      },
      warnings: insets.warnings,
    }
  },
  format: (measure) => {
    const lines = [describeDisplay(measure)]
    if (measure.line) {
      const { axis, at, pixel, runs } = measure.line
      lines.push(
        `${axis === 'row' ? 'Row' : 'Column'} at ${round2(at)} dp (${pixel} px), ${runs.length} runs:`,
        ...runs.map((run) => `  ${describeRun(run)}`),
      )
    }
    if (measure.element) {
      const { frame, toScreen, toSafeArea, offCentre, safeAreaSource } =
        measure.element
      const point = ({ x, y }: { x: number; y: number }) =>
        `x ${round2(x)}, y ${round2(y)}`
      lines.push(
        `${describeElement(measure.element)}: (${round2(frame.x)}, ${round2(frame.y)}) ${round2(frame.width)} × ${round2(frame.height)} dp`,
        `To the screen edges: ${describeInsets(toScreen)}`,
        `To the safe area (${safeAreaSource}): ${describeInsets(toSafeArea)}`,
        `Off centre: ${point(offCentre.screen)} dp from the screen centre, ${point(offCentre.safeArea)} dp from the safe-area centre`,
      )
    }
    lines.push(...measure.warnings.map((warning) => `Warning: ${warning}`))
    return lines.join('\n')
  },
})
