import { z } from 'zod'
import { defineCommand } from '../core/command'
import { appField, deviceField } from '../core/device'
import { describeDisplay } from '../core/display'
import { describeInsets, insetsReadingSchema } from '../core/insets'
import { selectAndroidOnly } from '../drivers/select'
import { readAndroidInsets } from '../drivers/android/insets'

export const insetsCommand = defineCommand({
  name: 'insets',
  summary:
    'Read the safe-area insets and the cutout of the current orientation',
  readOnly: true,
  input: z.object({
    app: appField.describe(
      "The package of the app under test, for example host.exp.exponent for Expo Go. loupe then reads the app's probe only while that app is in front. On a real device, loupe reads the probe only with this option.",
    ),
    device: deviceField,
  }),
  output: insetsReadingSchema,
  run: async ({ app, device }, context) =>
    readAndroidInsets(await selectAndroidOnly(context, device), app),
  format: (reading) =>
    [
      describeDisplay(reading),
      `Safe area, from ${reading.source === 'probe' ? "the app's probe" : 'dumpsys'}: ${describeInsets(reading.safeArea)}`,
      `System bars: ${describeInsets(reading.systemBars)}`,
      `Cutout: ${describeInsets(reading.cutout)}`,
      ...reading.warnings.map((warning) => `Warning: ${warning}`),
    ].join('\n'),
})
