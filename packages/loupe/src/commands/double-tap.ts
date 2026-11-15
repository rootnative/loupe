import { z } from 'zod'
import { defineCommand } from '../core/command'
import { appField, deviceField } from '../core/device'
import { selectorFields, targetOf } from '../core/element'
import {
  aimedTouchSchema,
  coordinateField,
  describeTouched,
} from '../core/touch'
import { selectAndroidDevice } from '../drivers/android/devices'
import { aimAndroid } from '../drivers/android/element'
import { doubleTapAndroid } from '../drivers/android/gesture'

export const doubleTapCommand = defineCommand({
  name: 'double-tap',
  summary:
    'Tap one point or element twice, as a double-tap, by text, label or id',
  input: z.object({
    x: coordinateField('x').optional(),
    y: coordinateField('y').optional(),
    ...selectorFields,
    app: appField,
    device: deviceField,
  }),
  positionals: ['x', 'y'],
  output: aimedTouchSchema.extend({
    gap: z
      .number()
      .describe('Milliseconds between the two taps, measured on the device.'),
  }),
  run: async ({ app, device, ...input }, context) => {
    const target = await selectAndroidDevice(context, device)
    const { point, element } = await aimAndroid(target, targetOf(input), app)
    return { ...(await doubleTapAndroid(target, point, app)), element }
  },
  format: (touch) =>
    `Double-tapped ${describeTouched(touch)} dp, ${touch.gap} ms between the taps`,
})
