import { z } from 'zod'
import { defineCommand } from '../core/command'
import { appField, deviceField } from '../core/device'
import { describeDisplay, displaySchema } from '../core/display'
import { writeOutputFile } from '../core/output-file'
import { describeProbe, probeReportSchema } from '../core/probe'
import { describeUiTree, uiNodeSchema } from '../core/ui'
import { selectAndroidOnly } from '../drivers/select'
import { readAndroidUi } from '../drivers/android/ui'

export const uiCommand = defineCommand({
  name: 'ui',
  summary: 'Read the accessibility tree of the screen, with frames in dp',
  readOnly: true,
  input: z.object({
    out: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Also write the result as JSON to this file, to give to check as mirrorOf later. loupe makes its folder, and replaces a file that is there.',
      ),
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
    probe: probeReportSchema
      .optional()
      .describe(
        "The report of the app's <LoupeProbe />, when the screen shows one. The probe's own node isn't in nodes.",
      ),
    file: z
      .string()
      .optional()
      .describe('The JSON file, as an absolute path. Left out with no out.'),
  }),
  run: async ({ out, app, device }, context) => {
    const ui = await readAndroidUi(
      await selectAndroidOnly(context, device),
      app,
    )
    const data = {
      ...ui.display,
      app: ui.app,
      nodes: ui.nodes,
      probe: ui.probe?.report,
    }
    if (out === undefined) return data
    const file = await writeOutputFile(out, Buffer.from(JSON.stringify(data)))
    return { ...data, file }
  },
  format: (ui) =>
    [
      ui.app ? `${describeDisplay(ui)}, ${ui.app}` : describeDisplay(ui),
      ...(ui.probe ? [describeProbe(ui.probe)] : []),
      ...describeUiTree(ui.nodes),
      ...(ui.file ? [`Saved ${ui.file}`] : []),
    ].join('\n'),
})
