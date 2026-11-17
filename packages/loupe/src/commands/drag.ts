import { z } from 'zod'
import { defineCommand } from '../core/command'
import { appField, deviceField } from '../core/device'
import { writeOutputFile } from '../core/output-file'
import {
  coordinateField,
  describePoint,
  durationField,
  touchSchema,
} from '../core/touch'
import { waitedSchema, waitFields, withWaited } from '../core/wait'
import { selectAndroidDevice } from '../drivers/android/devices'
import { dragAndroid } from '../drivers/android/gesture'
import { waitAfterAction } from '../drivers/android/wait'

export const dragCommand = defineCommand({
  name: 'drag',
  summary:
    'Touch, hold, move, hold and lift, with a screenshot while the touch is down',
  input: z.object({
    fromX: coordinateField('x'),
    fromY: coordinateField('y'),
    toX: coordinateField('x'),
    toY: coordinateField('y'),
    duration: durationField(
      300,
      'for the move, at the least: each of the 10 steps adds one call, 5 to 100 ms',
    ),
    holdStart: durationField(0, 'to hold the touch before it moves'),
    holdEnd: durationField(0, 'to hold the touch at the end, before it lifts'),
    shot: z
      .string()
      .min(1)
      .optional()
      .describe(
        'A PNG file. loupe takes a screenshot while the touch is down, and writes it there.',
      ),
    shotAt: z
      .number()
      .min(0)
      .max(1)
      .default(1)
      .describe(
        'Where along the move loupe takes the screenshot: 0 is after the start hold, 1 is after the end hold. In between, the touch pauses there while the screenshot runs.',
      ),
    ...waitFields,
    app: appField,
    device: deviceField,
  }),
  positionals: ['fromX', 'fromY', 'toX', 'toY'],
  output: touchSchema.extend({
    holdStart: z.number(),
    holdEnd: z.number(),
    moveTime: z
      .number()
      .describe(
        'Milliseconds that the move took, with a screenshot in the move: on an emulator, measured on the host through the emulator console; on a real device, measured on the device.',
      ),
    shot: z.string().optional().describe('The PNG file, as an absolute path.'),
    waited: waitedSchema.optional(),
  }),
  run: async (
    {
      fromX,
      fromY,
      toX,
      toY,
      shot,
      shotAt,
      app,
      device,
      waitStill,
      waitText,
      waitTimeout,
      ...timing
    },
    context,
  ) => {
    const target = await selectAndroidDevice(context, device)
    const { png, ...drag } = await dragAndroid(
      target,
      { x: fromX, y: fromY },
      { x: toX, y: toY },
      { ...timing, shotAt: shot ? shotAt : undefined },
      app,
    )
    const file = shot && png ? await writeOutputFile(shot, png) : undefined
    const waited = await waitAfterAction(
      target,
      app,
      { waitStill, waitText, waitTimeout },
      'drag',
    )
    return { ...drag, shot: file, waited }
  },
  format: ({ points, moveTime, shot, waited }) =>
    withWaited(
      [
        `Dragged ${points.map(describePoint).join(' → ')} dp; the move took ${moveTime} ms`,
        ...(shot ? [`Saved ${shot}`] : []),
      ].join('\n'),
      waited,
    ),
})
