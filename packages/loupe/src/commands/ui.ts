import { z } from 'zod'
import { defineCommand } from '../core/command'
import { appField, deviceField } from '../core/device'
import { describeDisplay, displaySchema } from '../core/display'
import { describeUiTree, uiNodeSchema } from '../core/ui'
import { selectAndroidDevice } from '../drivers/android/devices'
import { readAndroidUi } from '../drivers/android/ui'

export const uiCommand = defineCommand({
  name: 'ui',
  summary: 'Read the accessibility tree of the screen, with frames in dp',
  input: z.object({
    app: appField,
    device: deviceField,
  }),
  output: displaySchema.extend({
    app: z
      .string()
      .optional()
      .describe('The package of the window in the tree.'),
    nodes: z
      .array(uiNodeSchema)
      .describe(
        'The tree of the window in front. A system sheet, for example the share sheet, takes the place of the app below it.',
      ),
  }),
  run: async ({ app, device }, context) => {
    const ui = await readAndroidUi(
      await selectAndroidDevice(context, device),
      app,
    )
    return { ...ui.display, app: ui.app, nodes: ui.nodes }
  },
  format: (ui) =>
    [
      ui.app ? `${describeDisplay(ui)}, ${ui.app}` : describeDisplay(ui),
      ...describeUiTree(ui.nodes),
    ].join('\n'),
})
