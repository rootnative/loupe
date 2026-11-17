import { z } from 'zod'
import {
  describeResults,
  RULE_CHECKS,
  ruleResultSchema,
  RULES,
  rulesOf,
} from '../core/check'
import { defineCommand } from '../core/command'
import { appField, deviceField } from '../core/device'
import { describeDisplay, displaySchema } from '../core/display'
import { type Selector } from '../core/element'
import { LoupeError } from '../core/errors'
import { type Image } from '../core/png'
import { decodeCapture } from '../core/screenshot'
import { selectAndroidDevice } from '../drivers/android/devices'
import { insetsOfUi } from '../drivers/android/insets'
import { captureAndroid } from '../drivers/android/screenshot'
import { readAndroidUi } from '../drivers/android/ui'

const centredField = (by: string) =>
  z
    .array(z.string().min(1))
    .optional()
    .describe(
      `For the centred rule: the element with this ${by} must be at the centre of its container, whatever sits beside it. Give it once for each element.`,
    )

export const checkCommand = defineCommand({
  name: 'check',
  summary:
    'Check the screen for layout defects: elements under an inset, cut at an edge, off centre, or too small to touch',
  input: z.object({
    rules: z
      .string()
      .regex(/^[a-z-]+(,[a-z-]+)*$/, 'The rules are a comma list.')
      .optional()
      .describe(
        `The rules to run, as a comma list. Each one by default: ${RULES.join(', ')}.`,
      ),
    centred: centredField('text (the whole text)'),
    centredLabel: centredField('accessibility label'),
    centredId: centredField('id'),
    app: appField,
    device: deviceField,
  }),
  output: displaySchema.extend({
    app: z
      .string()
      .optional()
      .describe('The package of the window in the tree.'),
    safeAreaSource: z
      .enum(['probe', 'dumpsys'])
      .describe('Where the safe area comes from, as in `insets`.'),
    passed: z.boolean().describe('True when every rule passed.'),
    results: z.array(ruleResultSchema),
    warnings: z.array(z.string()),
  }),
  run: async (input, context) => {
    const names = rulesOf(input.rules)
    const centred: Selector[] = [
      ...(input.centred ?? []).map((value) => ({ by: 'text' as const, value })),
      ...(input.centredLabel ?? []).map((value) => ({
        by: 'label' as const,
        value,
      })),
      ...(input.centredId ?? []).map((value) => ({ by: 'id' as const, value })),
    ]
    if (centred.length > 0 && !names.includes('centred')) {
      throw new LoupeError(
        'invalid_input',
        'The centred elements need the centred rule. Add "centred" to the rules.',
      )
    }

    const target = await selectAndroidDevice(context, input.device)
    const ui = await readAndroidUi(target, input.app)
    const insets = await insetsOfUi(target, ui)
    let image: Image | undefined
    if (names.includes('centred')) {
      image = decodeCapture((await captureAndroid(target, input.app)).png)
      const { pixels } = ui.display
      if (image.width !== pixels.width || image.height !== pixels.height) {
        throw new LoupeError(
          'not_idle',
          `The screen turned between the tree and the screenshot (${pixels.width} × ${pixels.height} px, then ${image.width} × ${image.height} px). Wait until it's still, then try again.`,
        )
      }
    }
    const screen = {
      display: ui.display,
      app: ui.app,
      nodes: ui.nodes,
      insets,
      image,
    }
    const results = names.map((name) => RULE_CHECKS[name](screen, { centred }))
    return {
      ...ui.display,
      app: ui.app,
      safeAreaSource: insets.source,
      passed: results.every((result) => result.passed),
      results,
      warnings: insets.warnings,
    }
  },
  passed: (check) => check.passed,
  format: (check) =>
    [
      check.app
        ? `${describeDisplay(check)}, ${check.app}`
        : describeDisplay(check),
      ...describeResults(check.results),
      ...check.warnings.map((warning) => `Warning: ${warning}`),
    ].join('\n'),
})
