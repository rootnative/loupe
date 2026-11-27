import { z } from 'zod'
import { defineCommand } from '../core/command'
import { appField, deviceField } from '../core/device'
import { waitedSchema, waitFields, withWaited } from '../core/wait'
import { selectAndroidOnly } from '../drivers/select'
import { typeAndroid } from '../drivers/android/keys'
import { waitAfterAction } from '../drivers/android/wait'

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
    ...waitFields,
    app: appField,
    device: deviceField,
  }),
  positionals: ['text'],
  // The output has no text: it can be a password.
  output: z.object({
    characters: z.number().int(),
    waited: waitedSchema.optional(),
  }),
  run: async ({ text, app, device, ...wait }, context) => {
    const target = await selectAndroidOnly(context, device)
    const typed = await typeAndroid(target, text, app)
    const waited = await waitAfterAction(target, app, wait, 'type')
    return { ...typed, waited }
  },
  format: ({ characters, waited }) =>
    withWaited(
      `Typed ${characters} ${characters === 1 ? 'character' : 'characters'}`,
      waited,
    ),
})
