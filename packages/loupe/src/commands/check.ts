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
import { selectAndroidDevice } from '../drivers/android/devices'
import { insetsOfUi } from '../drivers/android/insets'
import { readAndroidUi } from '../drivers/android/ui'

export const checkCommand = defineCommand({
  name: 'check',
  summary:
    'Check the screen for layout defects: elements under an inset, cut at an edge, or too small to touch',
  input: z.object({
    rules: z
      .string()
      .regex(/^[a-z-]+(,[a-z-]+)*$/, 'The rules are a comma list.')
      .optional()
      .describe(
        `The rules to run, as a comma list. Each one by default: ${RULES.join(', ')}.`,
      ),
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
  run: async ({ rules, app, device }, context) => {
    const names = rulesOf(rules)
    const target = await selectAndroidDevice(context, device)
    const ui = await readAndroidUi(target, app)
    const insets = await insetsOfUi(target, ui)
    const screen = { display: ui.display, app: ui.app, nodes: ui.nodes, insets }
    const results = names.map((name) => RULE_CHECKS[name](screen))
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
