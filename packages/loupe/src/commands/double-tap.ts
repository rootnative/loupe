import { z } from 'zod'
import { defineCommand } from '../core/command'
import { appField, deviceField } from '../core/device'
import { coordinateField, describePoint, touchSchema } from '../core/touch'
import { selectAndroidDevice } from '../drivers/android/devices'
import { doubleTapAndroid } from '../drivers/android/gesture'

export const doubleTapCommand = defineCommand({
  name: 'double-tap',
  summary: 'Tap one point of the screen twice, as a double-tap',
  input: z.object({
    x: coordinateField('x'),
    y: coordinateField('y'),
    app: appField,
    device: deviceField,
  }),
  positionals: ['x', 'y'],
  output: touchSchema.extend({
    gap: z
      .number()
      .describe('Milliseconds between the two taps, measured on the device.'),
  }),
  run: async ({ x, y, app, device }, context) =>
    doubleTapAndroid(await selectAndroidDevice(context, device), { x, y }, app),
  format: ({ points, gap }) =>
    `Double-tapped ${points.map(describePoint).join(' ')} dp, ${gap} ms between the taps`,
})
