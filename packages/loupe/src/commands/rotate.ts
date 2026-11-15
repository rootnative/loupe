import { z } from 'zod'
import { defineCommand } from '../core/command'
import { deviceField } from '../core/device'
import {
  describeDisplay,
  displaySchema,
  orientationDescription,
} from '../core/display'
import { selectAndroidDevice } from '../drivers/android/devices'
import { rotateAndroid } from '../drivers/android/display'

export const rotateCommand = defineCommand({
  name: 'rotate',
  summary: 'Turn the screen, and wait until it has turned',
  input: z.object({
    to: z
      .enum(['portrait', 'landscape-left', 'landscape-right'])
      .describe(orientationDescription),
    device: deviceField,
    timeout: z
      .number()
      .int()
      .min(0)
      .default(5000)
      .describe('Milliseconds to wait for the screen to turn.'),
  }),
  positionals: ['to'],
  output: displaySchema,
  run: async ({ to, device, timeout }, context) =>
    rotateAndroid(await selectAndroidDevice(context, device), to, { timeout }),
  format: describeDisplay,
})
