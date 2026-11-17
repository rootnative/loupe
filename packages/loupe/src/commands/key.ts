import { z } from 'zod'
import { defineCommand } from '../core/command'
import { appField, deviceField } from '../core/device'
import { KEY_NAMES } from '../core/keys'
import { waitedSchema, waitFields, withWaited } from '../core/wait'
import { selectAndroidDevice } from '../drivers/android/devices'
import { pressAndroid } from '../drivers/android/keys'
import { waitAfterAction } from '../drivers/android/wait'

export const keyCommand = defineCommand({
  name: 'key',
  summary: 'Press one key, for example back, home or enter',
  input: z.object({
    key: z.enum(KEY_NAMES),
    ...waitFields,
    app: appField,
    device: deviceField,
  }),
  positionals: ['key'],
  output: z.object({
    key: z.enum(KEY_NAMES),
    waited: waitedSchema.optional(),
  }),
  run: async ({ key, app, device, ...wait }, context) => {
    const target = await selectAndroidDevice(context, device)
    const pressed = await pressAndroid(target, key, app)
    const waited = await waitAfterAction(target, app, wait, 'key')
    return { ...pressed, waited }
  },
  format: ({ key, waited }) => withWaited(`Pressed ${key}`, waited),
})
