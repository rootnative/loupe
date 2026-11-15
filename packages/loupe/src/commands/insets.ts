import { z } from 'zod'
import { defineCommand } from '../core/command'
import { deviceField } from '../core/device'
import { describeDisplay } from '../core/display'
import { describeInsets, insetsReadingSchema } from '../core/insets'
import { selectAndroidDevice } from '../drivers/android/devices'
import { readAndroidInsets } from '../drivers/android/insets'

export const insetsCommand = defineCommand({
  name: 'insets',
  summary:
    'Read the safe-area insets and the cutout of the current orientation',
  input: z.object({ device: deviceField }),
  output: insetsReadingSchema,
  run: async ({ device }, context) =>
    readAndroidInsets(await selectAndroidDevice(context, device)),
  format: (reading) =>
    [
      describeDisplay(reading),
      `Safe area: ${describeInsets(reading.safeArea)}`,
      `System bars: ${describeInsets(reading.systemBars)}`,
      `Cutout: ${describeInsets(reading.cutout)}`,
      ...reading.warnings.map((warning) => `Warning: ${warning}`),
    ].join('\n'),
})
