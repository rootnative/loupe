import { z } from 'zod'
import { defineCommand } from '../core/command'
import { appField, deviceField } from '../core/device'
import { waitedSchema, waitFields, withWaited } from '../core/wait'
import { selectAndroidDevice } from '../drivers/android/devices'
import { openUrlAndroid } from '../drivers/android/open-url'
import { waitAfterAction } from '../drivers/android/wait'

export const openUrlCommand = defineCommand({
  name: 'open-url',
  summary: 'Open a link (a deep link or a web page), and wait until it opens',
  input: z.object({
    url: z
      .string()
      .regex(
        /^[A-Za-z][A-Za-z0-9+.-]*:\S+$/,
        'A URL starts with a scheme, for example https: or exp:, and has no spaces.',
      ),
    app: appField.describe(
      'The package of the app under test. Then only that app opens the link. A real device needs it.',
    ),
    ...waitFields,
    device: deviceField,
  }),
  positionals: ['url'],
  output: z.object({
    url: z.string(),
    activity: z
      .string()
      .optional()
      .describe('The activity that opened the link: package/activity.'),
    launchState: z.string().optional().describe('cold, warm or hot.'),
    totalTime: z
      .number()
      .optional()
      .describe('Milliseconds, as Android measured the start.'),
    waited: waitedSchema.optional(),
  }),
  run: async ({ url, app, device, ...wait }, context) => {
    const target = await selectAndroidDevice(context, device)
    const opened = await openUrlAndroid(target, url, app)
    const waited = await waitAfterAction(target, app, wait, 'open-url')
    return { ...opened, waited }
  },
  format: ({ url, activity, launchState, totalTime, waited }) =>
    withWaited(
      [
        `Opened ${url}`,
        ...(activity ? [`in ${activity}`] : []),
        ...(launchState && totalTime !== undefined
          ? [`(${launchState}, ${totalTime} ms)`]
          : []),
      ].join(' '),
      waited,
    ),
})
