import { z } from 'zod'
import { defineCommand } from '../core/command'
import { deviceField } from '../core/device'
import { portField } from '../expo/metro'
import {
  describeShown,
  showApp,
  showTimeoutField,
  shownSchema,
} from './expo-open'

export const expoReloadCommand = defineCommand({
  name: 'expo-reload',
  summary:
    'Stop Expo Go and open the app again, so its JavaScript starts again, and wait until it shows',
  input: z.object({
    route: z
      .string()
      .optional()
      .describe(
        'The route to open after the stop, for example /settings. By default the route that the probe shows before the stop, else the root.',
      ),
    port: portField,
    timeout: showTimeoutField,
    device: deviceField,
  }),
  positionals: ['route'],
  output: shownSchema,
  run: (input, context) => showApp(context, input, { reload: true }),
  format: (shown) =>
    describeShown(
      `Stopped Expo Go${shown.expoGo ? ` ${shown.expoGo}` : ''} and opened ${shown.link} again`,
      shown,
    ),
})
