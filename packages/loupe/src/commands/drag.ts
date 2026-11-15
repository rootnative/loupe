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
import { selectAndroidDevice } from '../drivers/android/devices'
import { dragAndroid } from '../drivers/android/gesture'

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
  }),
  run: async (
    { fromX, fromY, toX, toY, shot, shotAt, app, device, ...timing },
    context,
  ) => {
    const { png, ...drag } = await dragAndroid(
      await selectAndroidDevice(context, device),
      { x: fromX, y: fromY },
      { x: toX, y: toY },
      { ...timing, shotAt: shot ? shotAt : undefined },
      app,
    )
    return {
      ...drag,
      shot: shot && png ? await writeOutputFile(shot, png) : undefined,
    }
  },
  format: ({ points, moveTime, shot }) =>
    [
      `Dragged ${points.map(describePoint).join(' → ')} dp; the move took ${moveTime} ms`,
      ...(shot ? [`Saved ${shot}`] : []),
    ].join('\n'),
})
