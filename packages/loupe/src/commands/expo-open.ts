import { z } from 'zod'
import { defineCommand } from '../core/command'
import { type CommandContext } from '../core/context'
import { deviceField } from '../core/device'
import { selectAndroidDevice } from '../drivers/android/devices'
import {
  forceStopExpoGo,
  probeRouteInExpoGo,
  readExpoGoVersion,
  reverseAndroid,
  showInExpoGo,
  waitStillInExpoGo,
} from '../drivers/android/expo'
import { expoLink, sdkWarning } from '../expo/expo-go'
import { DEFAULT_PORT, portField, warmExpo } from '../expo/metro'

// The first open took 13–15 s with the onboarding sheet and the menu, and
// 50 s behind an "isn't responding" dialog (round 10).
const DEFAULT_SHOW_TIMEOUT = 120_000
// Metro (3 steps), then Expo Go opens the app, then it shows.
const STEPS = 5

/** The `timeout` of `expo-open` and `expo-reload`. */
export const showTimeoutField = z
  .number()
  .int()
  .min(1000)
  .max(600_000)
  .optional()
  .describe(
    `How long to wait for the app after the open, in ms. ${DEFAULT_SHOW_TIMEOUT} by default.`,
  )

/** The output of `expo-open` and `expo-reload`. */
export const shownSchema = z.object({
  link: z.string().describe('The link that loupe opened in Expo Go.'),
  app: z.object({
    name: z.string().optional(),
    slug: z.string().optional(),
    sdkVersion: z.string().optional(),
  }),
  expoGo: z
    .string()
    .optional()
    .describe('The version of Expo Go on the device.'),
  launchState: z
    .string()
    .optional()
    .describe('cold, warm or hot, as Android measured the first open.'),
  opens: z
    .number()
    .describe(
      'How many times loupe opened the link. Expo Go can lose a link while it starts.',
    ),
  closed: z
    .array(z.enum(['onboarding', 'dev-menu']))
    .describe(
      'The Expo Go sheets that loupe closed: the onboarding sheet of the first open, and the developer menu.',
    ),
  ms: z.number().describe('From the open until the app showed, in ms.'),
  route: z
    .string()
    .optional()
    .describe("The route that the app's probe shows."),
  probe: z
    .boolean()
    .describe(
      'True when the app has the probe. With no probe, loupe waited until no Expo Go screen showed and the screen kept still.',
    ),
  warnings: z.array(z.string()),
})

export type Shown = z.infer<typeof shownSchema>

export interface ShowInput {
  route?: string
  port?: number
  timeout?: number
  device?: string
}

/**
 * Opens the app in Expo Go and waits until it shows. With `reload`, loupe
 * stops Expo Go first, so the app starts in a new process: on `route`, else
 * on the route that the probe showed before the stop, else on the root.
 */
export async function showApp(
  context: CommandContext,
  {
    route,
    port = DEFAULT_PORT,
    timeout = DEFAULT_SHOW_TIMEOUT,
    device,
  }: ShowInput,
  reload = false,
): Promise<Shown> {
  const target = await selectAndroidDevice(context, device)
  const expoGo = await readExpoGoVersion(target)
  const warmed = await warmExpo(context, { port }, STEPS)
  const warnings: string[] = []
  const sdk = sdkWarning(expoGo, warmed.app.sdkVersion)
  if (sdk) warnings.push(sdk)
  await reverseAndroid(target, port)

  const openRoute = reload
    ? (route ?? (await probeRouteInExpoGo(target)))
    : route
  context.progress?.({
    progress: 4,
    total: STEPS,
    message: reload
      ? 'Expo Go stops, then opens the app again.'
      : 'Expo Go opens the app.',
  })
  if (reload) await forceStopExpoGo(target)
  const link = expoLink(port, openRoute)
  const start = Date.now()
  const shown = await showInExpoGo(target, {
    link,
    route: openRoute,
    timeout,
  })
  if (!shown.probe) {
    await waitStillInExpoGo(target, Math.max(0, timeout - (Date.now() - start)))
  }
  context.progress?.({ progress: STEPS, total: STEPS })

  const { launchState } = shown.opened
  if (reload && launchState !== undefined && launchState !== 'cold') {
    warnings.push(
      `Android gave the launch state ${launchState}, not cold, so Expo Go didn't stop. The app can still run its old JavaScript.`,
    )
  }
  return {
    link,
    app: warmed.app,
    expoGo,
    launchState,
    opens: shown.opens,
    closed: shown.closed,
    ms: Date.now() - start,
    route: shown.probe?.route,
    probe: shown.probe !== undefined,
    warnings,
  }
}

/** The text of a `Shown`, after `lead`: what loupe did. */
export function describeShown(
  lead: string,
  { app, opens, closed, ms, route, warnings }: Shown,
): string {
  return [
    [
      `${lead}: ${app.name ?? app.slug ?? 'the app'} shows`,
      ...(route ? [` on ${route}`] : []),
      ` after ${ms} ms`,
      ...(closed.length ? [`; closed ${closed.join(', ')}`] : []),
      ...(opens > 1 ? [`; opened ${opens} times`] : []),
      '.',
    ].join(''),
    ...warnings.map((warning) => `Warning: ${warning}`),
  ].join('\n')
}

export const expoOpenCommand = defineCommand({
  name: 'expo-open',
  summary:
    'Open the app in Expo Go on the device, at a route, and wait until it shows',
  input: z.object({
    route: z
      .string()
      .optional()
      .describe(
        'The route to open, for example /settings. The root by default. When the app has the probe, loupe waits until the probe shows this route.',
      ),
    port: portField,
    timeout: showTimeoutField,
    device: deviceField,
  }),
  positionals: ['route'],
  output: shownSchema,
  run: (input, context) => showApp(context, input),
  format: (shown) =>
    describeShown(
      `Opened ${shown.link} in Expo Go${shown.expoGo ? ` ${shown.expoGo}` : ''}`,
      shown,
    ),
})
