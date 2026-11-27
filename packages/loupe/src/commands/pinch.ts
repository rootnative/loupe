import { z } from 'zod'
import { defineCommand } from '../core/command'
import { appField, deviceField } from '../core/device'
import { selectorFields, targetOf } from '../core/element'
import { describePinch, pinchFields, pinchSchema } from '../core/pinch'
import { coordinateField, durationField } from '../core/touch'
import { waitedSchema, waitFields, withWaited } from '../core/wait'
import { selectAndroidOnly } from '../drivers/select'
import { aimAndroid } from '../drivers/android/element'
import { pinchAndroid } from '../drivers/android/pinch'
import { waitAfterAction } from '../drivers/android/wait'

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
    ...waitFields,
    app: appField,
    device: deviceField,
  }),
  positionals: ['x', 'y'],
  output: pinchSchema.extend({ waited: waitedSchema.optional() }),
  run: async (
    {
      app,
      device,
      x,
      y,
      text,
      label,
      id,
      waitStill,
      waitText,
      waitTimeout,
      ...shape
    },
    context,
  ) => {
    const target = await selectAndroidOnly(context, device)
    const { point, element } = await aimAndroid(
      target,
      targetOf({ x, y, text, label, id }),
      app,
    )
    const pinch = await pinchAndroid(target, point, shape, app)
    const waited = await waitAfterAction(
      target,
      app,
      { waitStill, waitText, waitTimeout },
      'pinch',
    )
    return { ...pinch, element, waited }
  },
  format: (pinch) => withWaited(describePinch(pinch), pinch.waited),
})
