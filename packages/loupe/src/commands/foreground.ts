import { z } from 'zod'
import { defineCommand } from '../core/command'
import { appField, deviceField } from '../core/device'
import { waitedSchema, waitFields, withWaited } from '../core/wait'
import {
  type Back,
  foregroundAndroid,
  WAYS_BACK,
} from '../drivers/android/app-switch'
import { selectAndroidOnly } from '../drivers/select'
import { waitAfterAction } from '../drivers/android/wait'

export const backSchema = z.object({
  way: z
    .enum(['in-front', ...WAYS_BACK])
    .describe(
      'How the app came back. in-front: it was in front already. recents: the Recents key two times, as a person does. task-lock: am task lock on its task, then lock stop; Android shows an "App unpinned" toast for a few seconds.',
    ),
  tried: z
    .array(z.enum(WAYS_BACK))
    .describe('Each way that loupe tried, in order.'),
  task: z.number().optional().describe('The id of the task that came back.'),
  ms: z
    .number()
    .describe(
      'Milliseconds from the first key or command until the app had the focus.',
    ),
})

/** One line for a person: how the app came back. */
export function describeBack(app: string, back: Back): string {
  if (back.way === 'in-front') return `${app} is in front already`
  const how =
    back.way === 'recents'
      ? 'with the Recents key'
      : 'with a task lock; Android shows an "App unpinned" toast for a few seconds'
  const first =
    back.tried.length > 1 ? "The Recents key didn't bring it back. " : ''
  return `${first}Brought ${app} to the front in ${back.ms} ms, ${how}`
}

export const foregroundCommand = defineCommand({
  name: 'foreground',
  summary:
    'Bring an app back to the front: its most recent task, as a person does from Recents',
  input: z.object({
    app: appField
      .unwrap()
      .describe(
        'The package of the app to bring back, for example host.exp.exponent for Expo Go.',
      ),
    ...waitFields,
    device: deviceField,
  }),
  positionals: ['app'],
  output: backSchema.extend({
    app: z.string(),
    waited: waitedSchema.optional(),
  }),
  run: async ({ app, device, waitStill, waitText, waitTimeout }, context) => {
    const target = await selectAndroidOnly(context, device)
    const back = await foregroundAndroid(target, app)
    const waited = await waitAfterAction(
      target,
      app,
      { waitStill, waitText, waitTimeout },
      'foreground',
    )
    return { app, ...back, waited }
  },
  format: ({ app, waited, ...back }) =>
    withWaited(describeBack(app, back), waited),
})
