import { z } from 'zod'
import { defineCommand } from '../core/command'
import { appField, deviceField } from '../core/device'
import { coordinateField, describePoint, touchSchema } from '../core/touch'
import { selectAndroidDevice } from '../drivers/android/devices'
import { tapAndroid } from '../drivers/android/touch'

export const tapCommand = defineCommand({
  name: 'tap',
  summary: 'Tap one point of the screen',
  input: z.object({
    x: coordinateField('x'),
    y: coordinateField('y'),
    app: appField,
    device: deviceField,
  }),
  positionals: ['x', 'y'],
  output: touchSchema,
  run: async ({ x, y, app, device }, context) =>
    tapAndroid(await selectAndroidDevice(context, device), { x, y }, app),
  format: ({ points, pixels, orientation }) =>
    `Tapped ${points.map(describePoint).join(' ')} dp, ${pixels.map(describePoint).join(' ')} px in ${orientation}`,
})
