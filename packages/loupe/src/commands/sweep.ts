import path from 'node:path'
import { z } from 'zod'
import { findingSchema, RULES, rulesOf } from '../core/check'
import { defineCommand } from '../core/command'
import { appField, deviceField } from '../core/device'
import { ORIENTATIONS, type Orientation } from '../core/display'
import { LoupeError } from '../core/errors'
import {
  sweep,
  SWEEP_DIRECTIONS,
  SWEEP_THEMES,
  type SweepDirection,
  sweepScreenSchema,
  type SweepTheme,
  sweepVariantSchema,
} from '../core/sweep'
import { DEFAULT_WAIT_TIMEOUT, timeoutField } from '../core/wait'
import { selectAndroidDevice } from '../drivers/android/devices'
import { requireAppOnDevice } from '../drivers/android/foreground'
import { androidSweepDriver } from '../drivers/android/sweep'
import { requireAppJson } from '../expo/app-config'
import { EXPO_GO } from '../expo/expo-go'
import { DEFAULT_PORT, portField } from '../expo/metro'
import { expoProject } from '../expo/rtl'

const SWEEP_RULES = RULES.filter((rule) => rule !== 'mirrored')
const LIST = /^[a-z-]+(,[a-z-]+)*$/

/** The names of a comma list, each one of `all`, with no name twice. */
function listOf<T extends string>(
  text: string | undefined,
  all: readonly T[],
  what: string,
): T[] | undefined {
  if (text === undefined) return undefined
  const names = text.split(',')
  const unknown = names.filter(
    (name) => !(all as readonly string[]).includes(name),
  )
  if (unknown.length > 0) {
    throw new LoupeError(
      'invalid_input',
      `${unknown.map((name) => JSON.stringify(name)).join(', ')} isn't ${what}. Use: ${all.join(', ')}.`,
    )
  }
  return [...new Set(names as T[])]
}

const failureSchema = sweepScreenSchema
  .pick({
    number: true,
    url: true,
    variant: true,
    scrolled: true,
    reloaded: true,
    screenshot: true,
    error: true,
  })
  .extend({
    rules: z.array(z.string()).describe('The rules that failed.'),
    findings: z
      .array(
        findingSchema
          .pick({ element: true, message: true })
          .extend({ rule: z.enum(RULES) }),
      )
      .describe(
        'Each finding of those rules: the element, and a message with the numbers in dp. The report also has the numbers by name.',
      ),
  })

export const sweepCommand = defineCommand({
  name: 'sweep',
  summary:
    'Open each link in each orientation, theme and direction, check each screen, and write a report, the screenshots and a contact sheet for each variant',
  input: z.object({
    url: z
      .array(
        z
          .string()
          .regex(
            /^[A-Za-z][A-Za-z0-9+.-]*:\S+$/,
            'A URL starts with a scheme, for example https: or exp:, and has no spaces.',
          ),
      )
      .min(1)
      .describe(
        'A link to open and check: a deep link or a web page. Give it once for each screen.',
      ),
    orientation: z
      .string()
      .regex(LIST, 'The orientations are a comma list.')
      .optional()
      .describe(
        `The orientations to check, as a comma list of ${ORIENTATIONS.join(', ')}. Left out: only the one that the device has, and loupe turns nothing.`,
      ),
    theme: z
      .string()
      .regex(LIST, 'The themes are a comma list.')
      .optional()
      .describe(
        `The themes to check, as a comma list of ${SWEEP_THEMES.join(', ')}. Left out: only the one that the device has, and loupe sets nothing.`,
      ),
    rules: z
      .string()
      .regex(LIST, 'The rules are a comma list.')
      .optional()
      .describe(
        `The rules to run on each screen, as a comma list. Each one by default: ${SWEEP_RULES.join(', ')}.`,
      ),
    out: z
      .string()
      .min(1)
      .default('loupe-sweep')
      .describe(
        'The folder for report.json, the screenshots (<variant>/<number>.png) and the contact sheets (<variant>.png). Files that are there are replaced.',
      ),
    scroll: z
      .boolean()
      .optional()
      .describe(
        'Also scroll each screen down once, by 60 % of its largest vertical scroll view, and check it again: <variant>/<number>-scrolled.png and <variant>-scrolled.png. Then loupe scrolls back to the top.',
      ),
    direction: z
      .string()
      .regex(LIST, 'The directions are a comma list.')
      .optional()
      .describe(
        `The layout directions to check, as a comma list of ${SWEEP_DIRECTIONS.join(', ')}. Only for an app in Expo Go (app ${EXPO_GO}): loupe sets each one in app.json as expo-rtl does, opens the app again, and puts app.json back at the end. Left out: only the direction that the app has.`,
      ),
    port: portField.describe(
      `The port of Metro on this machine (npx expo start), for direction. ${DEFAULT_PORT} by default.`,
    ),
    reloadEvery: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(
        'Stop the app before each N-th link that the sweep opens, over all the variants, so the link starts it again: stacked screens slow an app down. In Expo Go, loupe then waits until the app shows the route of the link. Needs app. Left out: no restart.',
      ),
    waitTimeout: timeoutField.describe(
      `How long each screen can take to keep still after its link opens, in ms. ${DEFAULT_WAIT_TIMEOUT} by default.`,
    ),
    app: appField.describe(
      'The package of the app under test. Then only that app opens the links. A real device needs it.',
    ),
    device: deviceField,
  }),
  output: z.object({
    out: z.string().describe('The folder with each file of the sweep.'),
    report: z
      .string()
      .describe(
        'report.json: each screen with its number, link, variant, the result of each rule with its numbers, and its screenshot.',
      ),
    passed: z.boolean().describe('True when every screen passed.'),
    screens: z.number().describe('Links × variants, and each scrolled screen.'),
    failed: z.number(),
    variants: z.array(sweepVariantSchema),
    failures: z
      .array(failureSchema)
      .describe(
        'The screens that failed, each with its findings or its error. The report also has the screens that passed, and the warnings of each rule.',
      ),
    warnings: z.array(z.string()),
  }),
  run: async (input, context) => {
    const rules = input.rules === undefined ? SWEEP_RULES : rulesOf(input.rules)
    if (rules.includes('mirrored')) {
      throw new LoupeError(
        'invalid_input',
        'A sweep checks each screen on its own, so it has no mirrored rule. Run check --mirror-of on a screen for that.',
      )
    }
    const orientations = listOf<Orientation>(
      input.orientation,
      ORIENTATIONS,
      'an orientation',
    )
    const themes = listOf<SweepTheme>(input.theme, SWEEP_THEMES, 'a theme')
    if (input.reloadEvery !== undefined && input.app === undefined) {
      throw new LoupeError(
        'invalid_input',
        'reloadEvery needs app: the package that loupe stops before each N-th link.',
      )
    }
    const directions = listOf<SweepDirection>(
      input.direction,
      SWEEP_DIRECTIONS,
      'a direction',
    )
    const port = input.port ?? DEFAULT_PORT
    if (directions) {
      if (input.app !== EXPO_GO) {
        throw new LoupeError(
          'invalid_input',
          `direction needs the app in Expo Go: app ${EXPO_GO}. loupe sets the direction in app.json, as expo-rtl does.`,
        )
      }
      // Before the first screen, so a project that loupe can't switch
      // fails at once, not after the screens of the first direction.
      const { projectRoot, dynamicConfigPath } = await expoProject(
        context,
        port,
      )
      await requireAppJson(projectRoot, 'on', dynamicConfigPath)
    }

    const target = await selectAndroidDevice(context, input.device)
    requireAppOnDevice(target, input.app)
    const report = await sweep(
      androidSweepDriver(
        target,
        input.app,
        rules,
        { waitTimeout: input.waitTimeout ?? DEFAULT_WAIT_TIMEOUT },
        directions ? { context, port } : undefined,
      ),
      {
        urls: input.url,
        orientations,
        themes,
        out: input.out,
        scroll: input.scroll,
        reloadEvery: input.reloadEvery,
        directions,
      },
      context,
    )

    const failures = report.screens
      .filter((screen) => !screen.passed)
      .map(
        ({
          number,
          url,
          variant,
          scrolled,
          reloaded,
          screenshot,
          check,
          error,
        }) => {
          const failed = (check?.results ?? []).filter(
            (result) => !result.passed,
          )
          return {
            number,
            url,
            variant,
            scrolled,
            reloaded,
            screenshot,
            rules: failed.map((result) => result.rule),
            findings: failed.flatMap(({ rule, findings }) =>
              findings.map(({ element, message }) => ({
                rule,
                element,
                message,
              })),
            ),
            error,
          }
        },
      )
    return {
      out: report.out,
      report: path.join(report.out, 'report.json'),
      passed: report.passed,
      screens: report.screens.length,
      failed: failures.length,
      variants: report.variants,
      failures,
      warnings: report.warnings,
    }
  },
  passed: (result) => result.passed,
  images: ({ variants }) =>
    variants.flatMap(({ sheet, scrolledSheet }) =>
      scrolledSheet ? [sheet, scrolledSheet] : [sheet],
    ),
  format: ({ report, screens, failed, variants, failures, warnings }) =>
    [
      failed === 0
        ? `${screens} screens, each one passed.`
        : `${failed} of ${screens} screens failed.`,
      ...variants.map(
        (variant) =>
          `${variant.name}: ${variant.failed === 0 ? 'pass' : `${variant.failed} failed`}, contact sheet ${variant.sheet}${variant.scrolledSheet ? `, scrolled ${variant.scrolledSheet}` : ''}`,
      ),
      ...failures.flatMap(
        ({
          number,
          url,
          variant,
          scrolled,
          reloaded,
          rules,
          findings,
          error,
        }) => {
          const where = `  ${number} ${variant}${scrolled ? ' scrolled' : ''}${reloaded ? ' after a restart' : ''} ${url}`
          if (error) return [`${where}: ${error.code}: ${error.message}`]
          return [
            `${where}: ${rules.join(', ')}`,
            ...findings.map(({ rule, message }) => `    ${rule}: ${message}`),
          ]
        },
      ),
      `Report: ${report}`,
      ...warnings.map((warning) => `Warning: ${warning}`),
    ].join('\n'),
})
