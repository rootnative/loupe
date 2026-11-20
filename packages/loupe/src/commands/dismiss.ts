import { z } from 'zod'
import { defineCommand } from '../core/command'
import { appField, deviceField } from '../core/device'
import { waitedSchema, waitFields, withWaited } from '../core/wait'
import { selectAndroidDevice } from '../drivers/android/devices'
import {
  describeClosed,
  describeLayer,
  DISMISS_WAYS,
  dismissAndroid,
  LAYERS,
  MAX_LAYERS,
} from '../drivers/android/dismiss'
import { waitAfterAction } from '../drivers/android/wait'

const layerSchema = z
  .enum(LAYERS)
  .describe(
    `keyboard. stylus-sheet: the "Try out your stylus" sheet of Gboard's stylus mode, which a stylus touch starts (on an emulator, loupe's double-tap, drag and pinch are one). app-dialog: a dialog or a modal of the app. share-sheet: the system share sheet. permission-dialog: Android doesn't count Back as a denial, and the app's request can stay with no answer. notification-shade: also with the quick settings open. not-responding: an "isn't responding" dialog, of any app.`,
  )

const closedSchema = z.object({
  layer: layerSchema,
  way: z
    .enum(DISMISS_WAYS)
    .describe(
      `back: the Back key. escape: the Escape key, for the keyboard in Gboard's stylus mode, where Back also reaches the app. tap-cancel: a tap on Cancel in the stylus sheet. collapse: the status bar collapse, which closes the shade and the quick settings in one step. tap-wait: a tap on Wait in an "isn't responding" dialog, so the app gets more time.`,
    ),
  ms: z
    .number()
    .describe(
      'Milliseconds from the key, command or tap until the layer was gone.',
    ),
})

export const dismissCommand = defineCommand({
  name: 'dismiss',
  summary:
    'Close the top layer over the app: the keyboard, a dialog, a system sheet or the notification shade. With --all, each layer',
  input: z.object({
    all: z
      .boolean()
      .optional()
      .describe(
        `Close each layer, from the top, until the app's own screen shows: at most ${MAX_LAYERS}.`,
      ),
    ...waitFields,
    app: appField,
    device: deviceField,
  }),
  output: z.object({
    app: z
      .string()
      .optional()
      .describe(
        'The package under the layers. Left out when a layer still shows and the input has no app.',
      ),
    closed: z
      .array(closedSchema)
      .describe(
        'Each layer that loupe closed, from the top. Empty when nothing was open: then loupe sent no key.',
      ),
    next: layerSchema
      .optional()
      .describe(
        `The layer that shows now, when loupe stopped before the app: one call closes one layer, and --all stops after ${MAX_LAYERS}.`,
      ),
    waited: waitedSchema.optional(),
  }),
  run: async ({ all, app, device, ...wait }, context) => {
    const target = await selectAndroidDevice(context, device)
    const result = await dismissAndroid(target, app, { all })
    const waited = await waitAfterAction(target, app, wait, 'dismiss')
    return { ...result, waited }
  },
  format: ({ app, closed, next, waited }) => {
    const over = app ? ` over ${app}` : ''
    if (closed.length === 0) {
      return withWaited(`Nothing is open${over}: loupe sent no key.`, waited)
    }
    const done = `Closed ${closed.map(describeClosed).join(', then ')}.`
    if (!next) return withWaited(done, waited)

    const name = describeLayer(next)
    const then =
      closed.length < MAX_LAYERS
        ? 'run dismiss again, or dismiss --all'
        : `loupe stops after ${MAX_LAYERS} layers`
    return withWaited(
      `${done} ${name[0]?.toUpperCase()}${name.slice(1)} shows now: ${then}.`,
      waited,
    )
  },
})
