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
import { selectAndroidDevice } from '../drivers/android/devices'
import { aimAndroid } from '../drivers/android/element'
import { tapAndroid } from '../drivers/android/touch'

export const tapCommand = defineCommand({
  name: 'tap',
  summary:
    'Tap one point of the screen, or the element with a text, label or id',
  input: z.object({
    x: coordinateField('x').optional(),
    y: coordinateField('y').optional(),
    ...selectorFields,
    app: appField,
    device: deviceField,
  }),
  positionals: ['x', 'y'],
  output: aimedTouchSchema,
  run: async ({ app, device, ...input }, context) => {
    const target = await selectAndroidDevice(context, device)
    const { point, element } = await aimAndroid(target, targetOf(input), app)
    return { ...(await tapAndroid(target, point, app)), element }
  },
  format: (touch) =>
    `Tapped ${describeTouched(touch)} dp, ${touch.pixels.map(describePoint).join(' ')} px in ${touch.orientation}`,
})
