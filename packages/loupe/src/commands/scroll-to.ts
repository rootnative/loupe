import { z } from 'zod'
import { defineCommand } from '../core/command'
import { appField, deviceField } from '../core/device'
import { describeDisplay, displaySchema } from '../core/display'
import {
  describeElement,
  elementSchema,
  selectorFields,
  selectorOf,
} from '../core/element'
import { DIRECTIONS } from '../core/scroll'
import { round2 } from '../core/units'
import { selectAndroidOnly } from '../drivers/select'
import { scrollToAndroid } from '../drivers/android/scroll'

const DEFAULT_MAX_SCROLLS = 20

export const scrollToCommand = defineCommand({
  name: 'scroll-to',
  summary:
    'Scroll until the element with a text, label or id is in view, and give its frame',
  input: z.object({
    text: selectorFields.text.describe(
      'Scroll to the element with this text: the whole text, not a part.',
    ),
    label: selectorFields.label.describe(
      'Scroll to the element with this accessibility label (content-desc on Android).',
    ),
    id: selectorFields.id.describe(
      'Scroll to the element with this id: the resource-id on Android, or the part after ":id/".',
    ),
    direction: z
      .enum(DIRECTIONS)
      .default('down')
      .describe(
        'Where the content to show is: down shows what is below, so the touch moves up.',
      ),
    maxScrolls: z
      .number()
      .int()
      .min(0)
      .max(200)
      .default(DEFAULT_MAX_SCROLLS)
      .describe(
        'The most drags. Each one moves the scroll view by 60 % of its length.',
      ),
    in: z
      .string()
      .min(1)
      .optional()
      .describe(
        'The id of the scroll view to drag. By default, the innermost scroll view on the screen that scrolls along the direction; the largest one when there are more.',
      ),
    app: appField,
    device: deviceField,
  }),
  output: displaySchema.extend({
    element: elementSchema.describe('The element, as it shows at the end.'),
    direction: z.enum(DIRECTIONS),
    scrolls: z
      .number()
      .describe('The drags that loupe made: 0 when the element was in view.'),
    scrollView: elementSchema
      .optional()
      .describe('The scroll view of the last drag. Left out with no drag.'),
  }),
  run: async (input, context) => {
    const selector = selectorOf(input)
    const target = await selectAndroidOnly(context, input.device)
    const { display, ...scrolled } = await scrollToAndroid(
      target,
      selector,
      {
        direction: input.direction,
        maxScrolls: input.maxScrolls,
        in: input.in,
      },
      input.app,
    )
    return { ...display, ...scrolled, direction: input.direction }
  },
  format: ({ element, scrolls, direction, ...display }) => {
    const { x, y, width, height } = element.frame
    const how =
      scrolls === 0
        ? 'is in view'
        : `is in view after ${scrolls} ${scrolls === 1 ? 'drag' : 'drags'} ${direction}`
    return [
      describeDisplay(display),
      `${describeElement(element)} ${how}: (${round2(x)}, ${round2(y)}) ${round2(width)} × ${round2(height)} dp`,
    ].join('\n')
  },
})
