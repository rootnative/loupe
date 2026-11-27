import { z } from 'zod'
import { defineCommand } from '../core/command'
import { appField, deviceField } from '../core/device'
import { describeElement, selectorFields, type Selector } from '../core/element'
import { LoupeError } from '../core/errors'
import { round2 } from '../core/units'
import {
  DEFAULT_WAIT_INTERVAL,
  DEFAULT_WAIT_TIMEOUT,
  noElement,
  notStill,
  timeoutField,
  waitedSchema,
} from '../core/wait'
import { selectAndroidOnly } from '../drivers/select'
import {
  waitForElementAndroid,
  waitStillAndroid,
} from '../drivers/android/wait'

function sentence(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

export const waitCommand = defineCommand({
  name: 'wait',
  summary:
    'Wait until the screen keeps still, or until an element is on the screen',
  readOnly: true,
  input: z.object({
    still: z
      .boolean()
      .optional()
      .describe(
        'Wait until the screen keeps still: two equal screenshots in a row, with the system bars left out (the clock ticks there).',
      ),
    text: selectorFields.text.describe(
      'Wait until an element with this text (the whole text) is on the screen.',
    ),
    label: selectorFields.label.describe(
      'Wait until an element with this accessibility label is on the screen.',
    ),
    id: selectorFields.id.describe(
      'Wait until an element with this id is on the screen.',
    ),
    timeout: timeoutField,
    interval: z
      .number()
      .int()
      .min(0)
      .max(10_000)
      .optional()
      .describe(
        `The pause between two screenshots or two reads, in ms. ${DEFAULT_WAIT_INTERVAL} by default.`,
      ),
    app: appField,
    device: deviceField,
  }),
  output: waitedSchema,
  run: async ({ still, text, label, id, app, device, ...input }, context) => {
    const selectors: Selector[] = [
      ...(text === undefined ? [] : [{ by: 'text', value: text } as const]),
      ...(label === undefined ? [] : [{ by: 'label', value: label } as const]),
      ...(id === undefined ? [] : [{ by: 'id', value: id } as const]),
    ]
    const [selector] = selectors
    if ((still ? 1 : 0) + selectors.length !== 1) {
      throw new LoupeError(
        'invalid_input',
        'Name one thing to wait for: still, or one of text, label and id.',
      )
    }
    const options = {
      timeout: input.timeout ?? DEFAULT_WAIT_TIMEOUT,
      interval: input.interval ?? DEFAULT_WAIT_INTERVAL,
    }
    const target = await selectAndroidOnly(context, device)

    if (!selector) {
      const result = await waitStillAndroid(target, app, options)
      if (!result.still) {
        throw new LoupeError('timeout', sentence(notStill(result)))
      }
      return { ms: result.ms, frames: result.frames }
    }

    const result = await waitForElementAndroid(target, app, selector, options)
    if (!result.element) {
      const what = `${selector.by} ${JSON.stringify(selector.value)}`
      throw new LoupeError('timeout', sentence(noElement(what, result)))
    }
    return { ms: result.ms, reads: result.reads, element: result.element }
  },
  format: ({ ms, frames, reads, element }) => {
    const seconds = `${round2(ms / 1000)} s`
    return element
      ? `${describeElement(element)} is on the screen, after ${seconds} (${reads} reads).`
      : `The screen keeps still, after ${seconds} (${frames} screenshots).`
  },
})
