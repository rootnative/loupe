import { z } from 'zod'
import { defineCommand } from '../core/command'
import { DEFAULT_BUNDLE_TIMEOUT, portField, warmExpo } from '../expo/metro'

export const expoWarmCommand = defineCommand({
  name: 'expo-warm',
  summary:
    'Ask Metro for the app and its bundle, so that the first open in Expo Go is fast, and give the hash of the bundle',
  readOnly: true,
  input: z.object({
    port: portField,
    timeout: z
      .number()
      .int()
      .min(1000)
      .max(600_000)
      .optional()
      .describe(
        `How long to wait for the bundle at most, in ms. ${DEFAULT_BUNDLE_TIMEOUT} by default: a cold bundle of a large app can take minutes.`,
      ),
  }),
  output: z.object({
    server: z.string().describe('The Metro server that loupe asked.'),
    link: z
      .string()
      .describe(
        'The link that opens the app in Expo Go on Android, after adb reverse of the port.',
      ),
    app: z.object({
      name: z.string().optional(),
      slug: z.string().optional(),
      sdkVersion: z
        .string()
        .optional()
        .describe(
          'The Expo SDK of the app, for example 58.0.0. Expo Go must have the same major version.',
        ),
    }),
    projectRoot: z
      .string()
      .optional()
      .describe('The folder of the app on this machine, as Metro gives it.'),
    bundle: z.object({
      path: z
        .string()
        .describe('The path and query of the launch bundle on Metro.'),
      ms: z
        .number()
        .describe(
          'How long the bundle took, in ms: seconds when cold, under a second when warm.',
        ),
      bytes: z.number(),
      sha256: z
        .string()
        .describe(
          "The SHA-256 of the bundle. After an edit of the app's code, the same hash means that Metro didn't see the edit.",
        ),
    }),
  }),
  run: (input, context) => warmExpo(context, input),
  format: ({ server, app, bundle }) =>
    [
      `Metro at ${server}: ${app.name ?? app.slug ?? 'the app'}`,
      ...(app.sdkVersion ? [` (SDK ${app.sdkVersion})`] : []),
      `. The bundle: ${(bundle.bytes / 1_000_000).toFixed(2)} MB in ${bundle.ms} ms, sha256 ${bundle.sha256.slice(0, 12)}.`,
    ].join(''),
})
