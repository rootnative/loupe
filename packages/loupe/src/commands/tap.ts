import { z } from 'zod'
import { defineCommand } from '../core/command'
import { appField, deviceField } from '../core/device'
import { selectorFields, targetOf } from '../core/element'
import {
  aimedTouchSchema,
  coordinateField,
  describePoint,
  describeTouched,
} from '../core/touch'
import { waitedSchema, waitFields, withWaited } from '../core/wait'
import { selectAndroidOnly } from '../drivers/select'
import { aimAndroid } from '../drivers/android/element'
import { tapAndroid } from '../drivers/android/touch'
import { waitAfterAction } from '../drivers/android/wait'

export const tapCommand = defineCommand({
  name: 'tap',
  summary:
    'Tap one point of the screen, or the element with a text, label or id',
  input: z.object({
    x: coordinateField('x').optional(),
    y: coordinateField('y').optional(),
    ...selectorFields,
    ...waitFields,
    app: appField,
    device: deviceField,
  }),
  positionals: ['x', 'y'],
  output: aimedTouchSchema.extend({ waited: waitedSchema.optional() }),
  run: async (
    { app, device, waitStill, waitText, waitTimeout, ...input },
    context,
  ) => {
    const target = await selectAndroidOnly(context, device)
    const { point, element } = await aimAndroid(target, targetOf(input), app)
    const touch = await tapAndroid(target, point, app)
    const waited = await waitAfterAction(
      target,
      app,
      { waitStill, waitText, waitTimeout },
      'tap',
    )
    return { ...touch, element, waited }
  },
  format: (touch) =>
    withWaited(
      `Tapped ${describeTouched(touch)} dp, ${touch.pixels.map(describePoint).join(' ')} px in ${touch.orientation}`,
      touch.waited,
    ),
})
