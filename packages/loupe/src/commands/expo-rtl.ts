import { z } from 'zod'
import { defineCommand } from '../core/command'
import { deviceField } from '../core/device'
import { LoupeError } from '../core/errors'
import { RECORD_PATH, type RtlChange, setRtl } from '../expo/app-config'
import {
  DEFAULT_PORT,
  portField,
  readExpoApp,
  untilManifestRtl,
} from '../expo/metro'
import {
  describeShown,
  type Shown,
  showApp,
  showTimeoutField,
  shownSchema,
} from './expo-open'

export const expoRtlCommand = defineCommand({
  name: 'expo-rtl',
  summary:
    'Turn RTL on or off in the app.json of the app in Expo Go, then open the app again in that direction',
  input: z.object({
    rtl: z
      .enum(['on', 'off'])
      .describe(
        `on: supportsRTL and forcesRTL in the extra of app.json; loupe keeps app.json as it was in ${RECORD_PATH}. off: app.json as it was before on.`,
      ),
    route: z
      .string()
      .optional()
      .describe(
        'The route to open after the change, for example /settings. By default the route that the probe shows before it, else the root.',
      ),
    port: portField,
    timeout: showTimeoutField,
    device: deviceField,
  }),
  positionals: ['rtl', 'route'],
  output: shownSchema.extend({
    rtl: z.enum(['on', 'off']),
    file: z.string().describe('The app.json of the app, as an absolute path.'),
    changed: z.boolean().describe('True when loupe wrote app.json.'),
  }),
  run: async ({ rtl, ...input }, context) => {
    const port = input.port ?? DEFAULT_PORT
    const state: { change?: RtlChange } = {}
    let shown: Shown
    try {
      shown = await showApp(context, input, {
        reload: true,
        prepare: async () => {
          const app = await readExpoApp(context, port)
          if (!app.projectRoot) {
            throw new LoupeError(
              'unsupported',
              "The manifest of Metro gives no folder of the app, so loupe can't find app.json.",
            )
          }
          const change = await setRtl(
            app.projectRoot,
            rtl,
            app.dynamicConfigPath,
          )
          try {
            await untilManifestRtl(context, port, change.forces, input.timeout)
          } catch (error) {
            await change.undo()
            throw error
          }
          state.change = change
          // forcesRTL decides. With supportsRTL alone, the device language does.
          if (change.forces) return 'rtl'
          return change.supports ? undefined : 'ltr'
        },
      })
    } catch (error) {
      if (
        rtl === 'on' &&
        state.change?.changed &&
        error instanceof LoupeError
      ) {
        throw new LoupeError(
          error.code,
          `${error.message} app.json keeps RTL on: run expo-rtl off to put it back.`,
          { cause: error },
        )
      }
      throw error
    }

    const { file, changed } = state.change as RtlChange
    return {
      ...shown,
      warnings: shown.probe
        ? shown.warnings
        : [
            ...shown.warnings,
            "The app has no probe, so loupe didn't see the direction on the screen.",
          ],
      rtl,
      file,
      changed,
    }
  },
  format: ({ rtl, file, changed, ...shown }) =>
    describeShown(
      `RTL ${rtl}: loupe ${changed ? 'wrote' : "didn't change"} ${file}, stopped Expo Go and opened ${shown.link} again`,
      shown,
    ),
})
