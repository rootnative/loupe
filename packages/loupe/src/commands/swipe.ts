import { z } from 'zod'
import { defineCommand } from '../core/command'
import { appField, deviceField } from '../core/device'
import {
  coordinateField,
  describePoint,
  durationField,
  touchSchema,
} from '../core/touch'
import { waitedSchema, waitFields, withWaited } from '../core/wait'
import { selectAndroidDevice } from '../drivers/android/devices'
import { swipeAndroid } from '../drivers/android/touch'
import { waitAfterAction } from '../drivers/android/wait'

export const swipeCommand = defineCommand({
  name: 'swipe',
  summary: 'Move one touch in a straight line from one point to another',
  input: z.object({
    fromX: coordinateField('x'),
    fromY: coordinateField('y'),
    toX: coordinateField('x'),
    toY: coordinateField('y'),
    duration: durationField(300, 'from the first point to the last'),
    ...waitFields,
    app: appField,
    device: deviceField,
  }),
  positionals: ['fromX', 'fromY', 'toX', 'toY'],
  output: touchSchema.extend({ waited: waitedSchema.optional() }),
  run: async (
    { fromX, fromY, toX, toY, duration, app, device, ...wait },
    context,
  ) => {
    const target = await selectAndroidDevice(context, device)
    const touch = await swipeAndroid(
      target,
      { x: fromX, y: fromY },
      { x: toX, y: toY },
      duration,
      app,
    )
    const waited = await waitAfterAction(target, app, wait, 'swipe')
    return { ...touch, waited }
  },
  format: ({ points, duration, waited }) =>
    withWaited(
      `Swiped ${points.map(describePoint).join(' → ')} dp in ${duration} ms`,
      waited,
    ),
})
