import { z } from 'zod'
import { defineCommand } from '../core/command'
import { appField, deviceField } from '../core/device'
import { KEY_NAMES } from '../core/keys'
import { selectAndroidDevice } from '../drivers/android/devices'
import { pressAndroid } from '../drivers/android/keys'

export const keyCommand = defineCommand({
  name: 'key',
  summary: 'Press one key, for example back, home or enter',
  input: z.object({
    key: z.enum(KEY_NAMES),
    app: appField,
    device: deviceField,
  }),
  positionals: ['key'],
  output: z.object({ key: z.enum(KEY_NAMES) }),
  run: async ({ key, app, device }, context) =>
    pressAndroid(await selectAndroidDevice(context, device), key, app),
  format: ({ key }) => `Pressed ${key}`,
})
