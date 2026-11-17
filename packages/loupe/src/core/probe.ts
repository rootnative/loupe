import { z } from 'zod'
import { describeInsets, insetsSchema } from './insets'
import { round2 } from './units'

/**
 * The probe (`<LoupeProbe />` in `@rootnative/loupe-probe`) puts its report
 * in the accessibility label of one view: this prefix, then the report as
 * JSON. The two packages don't depend on each other, so the prefix and the
 * format number must stay the same as the probe's.
 */
export const PROBE_PREFIX = 'loupe:'
export const PROBE_FORMAT = 1

export const probeReportSchema = z.object({
  insets: insetsSchema
    .optional()
    .describe(
      "The app's safe-area insets, in dp (pt on iOS). Left out when the probe has no SafeAreaProvider above it.",
    ),
  window: z
    .object({ width: z.number(), height: z.number() })
    .describe('The window size that the app gets, in dp (pt on iOS).'),
  scale: z.number().describe('Pixels per dp (pt on iOS), as the app sees it.'),
  direction: z.enum(['ltr', 'rtl']).describe('The layout direction.'),
  colorScheme: z.enum(['light', 'dark']).optional(),
  route: z
    .string()
    .optional()
    .describe('The route that the app gives to the probe.'),
})

export type ProbeReport = z.infer<typeof probeReportSchema>

export interface ProbeReading {
  /** Left out when loupe can't read the report. */
  report?: ProbeReport
  warnings: string[]
}

export function isProbeLabel(label: string | undefined): label is string {
  return label?.startsWith(PROBE_PREFIX) ?? false
}

function readLabel(label: string): ProbeReport | string {
  let value: unknown
  try {
    value = JSON.parse(label.slice(PROBE_PREFIX.length))
  } catch {
    return "The label of the app's probe isn't JSON, so loupe can't read the report."
  }

  const format: unknown =
    typeof value === 'object' && value !== null && 'v' in value
      ? value.v
      : undefined
  if (format !== PROBE_FORMAT) {
    return format === undefined
      ? "The report of the app's probe has no format number, so loupe can't read it."
      : `The app's probe sends report format ${JSON.stringify(format)}, but this loupe reads only format ${PROBE_FORMAT}. Update loupe and the probe to their latest releases.`
  }

  const result = probeReportSchema.safeParse(value)
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join('.') || 'report'}: ${issue.message}`)
      .join('; ')
    return `loupe can't read the report of the app's probe. ${issues}`
  }
  return result.data
}

/**
 * Reads the labels of the probe nodes on the screen, in tree order.
 * Undefined when the screen has no probe.
 */
export function readProbe(labels: readonly string[]): ProbeReading | undefined {
  const [first] = labels
  if (first === undefined) return undefined

  const warnings: string[] = []
  if (labels.length > 1) {
    warnings.push(
      `The screen shows ${labels.length} probes, so loupe reads the first. Render <LoupeProbe /> once, near the root of the app.`,
    )
  }
  const report = readLabel(first)
  return typeof report === 'string'
    ? { warnings: [...warnings, report] }
    : { report, warnings }
}

/** One line for a person, with dp rounded to 2 places. */
export function describeProbe(report: ProbeReport): string {
  const { insets, window, direction, colorScheme, route } = report
  const parts = [
    route === undefined ? undefined : `route ${JSON.stringify(route)}`,
    direction,
    colorScheme,
    `window ${round2(window.width)} × ${round2(window.height)} dp`,
    insets ? `safe area ${describeInsets(insets)}` : 'no safe area',
  ]
  return `Probe: ${parts.filter(Boolean).join(', ')}`
}
