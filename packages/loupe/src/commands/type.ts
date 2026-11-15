import { z } from 'zod'
import { defineCommand } from '../core/command'
import { appField, deviceField } from '../core/device'
import { selectAndroidDevice } from '../drivers/android/devices'
import { typeAndroid } from '../drivers/android/keys'

export const typeCommand = defineCommand({
  name: 'type',
  summary: 'Type text into the field that has the focus',
  input: z.object({
    text: z
      .string()
      .min(1)
      .describe(
        'The text to type. On Android, printable ASCII only; press Enter with the key command.',
      ),
    app: appField,
    device: deviceField,
  }),
  positionals: ['text'],
  // The output has no text: it can be a password.
  output: z.object({ characters: z.number().int() }),
  run: async ({ text, app, device }, context) =>
    typeAndroid(await selectAndroidDevice(context, device), text, app),
  format: ({ characters }) =>
    `Typed ${characters} ${characters === 1 ? 'character' : 'characters'}`,
})
