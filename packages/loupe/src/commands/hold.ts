import { z } from 'zod'
import { defineCommand } from '../core/command'
import { appField, deviceField } from '../core/device'
import { selectorFields, targetOf } from '../core/element'
import {
  aimedTouchSchema,
  coordinateField,
  describeTouched,
  durationField,
} from '../core/touch'
import { waitedSchema, waitFields, withWaited } from '../core/wait'
import { selectAndroidOnly } from '../drivers/select'
import { aimAndroid } from '../drivers/android/element'
import { holdAndroid } from '../drivers/android/touch'
import { waitAfterAction } from '../drivers/android/wait'

export const holdCommand = defineCommand({
  name: 'hold',
  summary:
    'Touch one point or element and hold it (a long press), by text, label or id',
  input: z.object({
    x: coordinateField('x').optional(),
    y: coordinateField('y').optional(),
    ...selectorFields,
    duration: durationField(1000, 'to hold the touch'),
    ...waitFields,
    app: appField,
    device: deviceField,
  }),
  positionals: ['x', 'y'],
  output: aimedTouchSchema.extend({ waited: waitedSchema.optional() }),
  run: async (
    { duration, app, device, waitStill, waitText, waitTimeout, ...input },
    context,
  ) => {
    const target = await selectAndroidOnly(context, device)
    const { point, element } = await aimAndroid(target, targetOf(input), app)
    const touch = await holdAndroid(target, point, duration, app)
    const waited = await waitAfterAction(
      target,
      app,
      { waitStill, waitText, waitTimeout },
      'hold',
    )
    return { ...touch, element, waited }
  },
  format: (touch) =>
    withWaited(
      `Held ${describeTouched(touch)} dp for ${touch.duration} ms`,
      touch.waited,
    ),
})
