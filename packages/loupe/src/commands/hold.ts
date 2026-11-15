import { z } from 'zod'
import { defineCommand } from '../core/command'
import { appField, deviceField } from '../core/device'
import {
  coordinateField,
  describePoint,
  durationField,
  touchSchema,
} from '../core/touch'
import { selectAndroidDevice } from '../drivers/android/devices'
import { holdAndroid } from '../drivers/android/touch'

export const holdCommand = defineCommand({
  name: 'hold',
  summary: 'Touch one point of the screen and hold it (a long press)',
  input: z.object({
    x: coordinateField('x'),
    y: coordinateField('y'),
    duration: durationField(1000, 'to hold the touch'),
    app: appField,
    device: deviceField,
  }),
  positionals: ['x', 'y'],
  output: touchSchema,
  run: async ({ x, y, duration, app, device }, context) =>
    holdAndroid(
      await selectAndroidDevice(context, device),
      { x, y },
      duration,
      app,
    ),
  format: ({ points, duration }) =>
    `Held ${points.map(describePoint).join(' ')} dp for ${duration} ms`,
})
