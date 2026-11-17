import { z } from 'zod'
import { defineCommand } from '../core/command'
import { appField, deviceField } from '../core/device'
import { selectorFields, targetOf } from '../core/element'
import {
  aimedTouchSchema,
  coordinateField,
  describeTouched,
} from '../core/touch'
import { waitedSchema, waitFields, withWaited } from '../core/wait'
import { selectAndroidDevice } from '../drivers/android/devices'
import { aimAndroid } from '../drivers/android/element'
import { doubleTapAndroid } from '../drivers/android/gesture'
import { waitAfterAction } from '../drivers/android/wait'

export const doubleTapCommand = defineCommand({
  name: 'double-tap',
  summary:
    'Tap one point or element twice, as a double-tap, by text, label or id',
  input: z.object({
    x: coordinateField('x').optional(),
    y: coordinateField('y').optional(),
    ...selectorFields,
    ...waitFields,
    app: appField,
    device: deviceField,
  }),
  positionals: ['x', 'y'],
  output: aimedTouchSchema.extend({
    gap: z
      .number()
      .describe(
        'Milliseconds between the two taps: on an emulator, measured on the host through the emulator console; on a real device, measured on the device.',
      ),
    waited: waitedSchema.optional(),
  }),
  run: async (
    { app, device, waitStill, waitText, waitTimeout, ...input },
    context,
  ) => {
    const target = await selectAndroidDevice(context, device)
    const { point, element } = await aimAndroid(target, targetOf(input), app)
    const touch = await doubleTapAndroid(target, point, app)
    const waited = await waitAfterAction(
      target,
      app,
      { waitStill, waitText, waitTimeout },
      'double-tap',
    )
    return { ...touch, element, waited }
  },
  format: (touch) =>
    withWaited(
      `Double-tapped ${describeTouched(touch)} dp, ${touch.gap} ms between the taps`,
      touch.waited,
    ),
})
