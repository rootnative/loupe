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
import { swipeAndroid } from '../drivers/android/touch'

export const swipeCommand = defineCommand({
  name: 'swipe',
  summary: 'Move one touch in a straight line from one point to another',
  input: z.object({
    fromX: coordinateField('x'),
    fromY: coordinateField('y'),
    toX: coordinateField('x'),
    toY: coordinateField('y'),
    duration: durationField(300, 'from the first point to the last'),
    app: appField,
    device: deviceField,
  }),
  positionals: ['fromX', 'fromY', 'toX', 'toY'],
  output: touchSchema,
  run: async ({ fromX, fromY, toX, toY, duration, app, device }, context) =>
    swipeAndroid(
      await selectAndroidDevice(context, device),
      { x: fromX, y: fromY },
      { x: toX, y: toY },
      duration,
      app,
    ),
  format: ({ points, duration }) =>
    `Swiped ${points.map(describePoint).join(' → ')} dp in ${duration} ms`,
})
