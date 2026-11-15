import { z } from 'zod'
import { defineCommand } from '../core/command'
import { appField, deviceField } from '../core/device'
import { selectorFields, targetOf } from '../core/element'
import { describePinch, pinchFields, pinchSchema } from '../core/pinch'
import { coordinateField, durationField } from '../core/touch'
import { selectAndroidDevice } from '../drivers/android/devices'
import { aimAndroid } from '../drivers/android/element'
import { pinchAndroid } from '../drivers/android/pinch'

export const pinchCommand = defineCommand({
  name: 'pinch',
  summary:
    'Pinch or spread two fingers around a point or an element, and turn them (emulator only)',
  input: z.object({
    x: coordinateField('x').optional(),
    y: coordinateField('y').optional(),
    ...selectorFields,
    ...pinchFields,
    duration: durationField(
      300,
      'for the move, at the least: each of the 10 steps adds one console call, about 5 to 20 ms',
    ),
    app: appField,
    device: deviceField,
  }),
  positionals: ['x', 'y'],
  output: pinchSchema,
  run: async ({ app, device, x, y, text, label, id, ...shape }, context) => {
    const target = await selectAndroidDevice(context, device)
    const { point, element } = await aimAndroid(
      target,
      targetOf({ x, y, text, label, id }),
      app,
    )
    return { ...(await pinchAndroid(target, point, shape, app)), element }
  },
  format: describePinch,
})
