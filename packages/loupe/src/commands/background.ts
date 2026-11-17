import { z } from 'zod'
import { defineCommand } from '../core/command'
import { appField, deviceField } from '../core/device'
import { LoupeError } from '../core/errors'
import { waitedSchema, waitFields, withWaited } from '../core/wait'
import { backgroundAndroid } from '../drivers/android/app-switch'
import { selectAndroidDevice } from '../drivers/android/devices'
import { waitAfterAction } from '../drivers/android/wait'
import { backSchema, describeBack } from './foreground'

export const backgroundCommand = defineCommand({
  name: 'background',
  summary:
    'Send the app in front to the background with HOME, and with --for bring it back after that time',
  input: z.object({
    for: z
      .number()
      .int()
      .min(0)
      .max(600_000)
      .optional()
      .describe(
        'Milliseconds in the background. Then loupe brings the app back, as the foreground command does. With no value, the app stays in the background.',
      ),
    ...waitFields,
    app: appField,
    device: deviceField,
  }),
  output: z.object({
    app: z.string().describe('The package that went to the background.'),
    away: z
      .number()
      .optional()
      .describe(
        'Milliseconds from HOME to the first step back. Left out with no --for.',
      ),
    back: backSchema.optional().describe('How the app came back.'),
    waited: waitedSchema.optional(),
  }),
  run: async (input, context) => {
    const waits = [input.waitStill, input.waitText, input.waitTimeout]
    if (input.for === undefined && waits.some((wait) => wait !== undefined)) {
      throw new LoupeError(
        'invalid_input',
        'The wait options need --for: with no --for, the app stays in the background, and there is nothing to wait for.',
      )
    }
    const target = await selectAndroidDevice(context, input.device)
    const result = await backgroundAndroid(target, input.app, input.for)
    const waited = result.back
      ? await waitAfterAction(
          target,
          result.app,
          {
            waitStill: input.waitStill,
            waitText: input.waitText,
            waitTimeout: input.waitTimeout,
          },
          'background',
        )
      : undefined
    return { ...result, waited }
  },
  format: ({ app, away, back, waited }) => {
    const sent = `Sent ${app} to the background`
    return withWaited(
      back && away !== undefined
        ? `${sent} for ${away} ms. ${describeBack(app, back)}`
        : sent,
      waited,
    )
  },
})
