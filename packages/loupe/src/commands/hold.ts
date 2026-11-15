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
import { selectAndroidDevice } from '../drivers/android/devices'
import { aimAndroid } from '../drivers/android/element'
import { holdAndroid } from '../drivers/android/touch'

export const holdCommand = defineCommand({
  name: 'hold',
  summary:
    'Touch one point or element and hold it (a long press), by text, label or id',
  input: z.object({
    x: coordinateField('x').optional(),
    y: coordinateField('y').optional(),
    ...selectorFields,
    duration: durationField(1000, 'to hold the touch'),
    app: appField,
    device: deviceField,
  }),
  positionals: ['x', 'y'],
  output: aimedTouchSchema,
  run: async ({ duration, app, device, ...input }, context) => {
    const target = await selectAndroidDevice(context, device)
    const { point, element } = await aimAndroid(target, targetOf(input), app)
    return {
      ...(await holdAndroid(target, point, duration, app)),
      element,
    }
  },
  format: (touch) =>
    `Held ${describeTouched(touch)} dp for ${touch.duration} ms`,
})
