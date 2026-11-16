import { z } from 'zod'
import { defineCommand } from '../core/command'
import { appField, deviceField } from '../core/device'
import { describeDisplay, displaySchema } from '../core/display'
import { writeOutputFile } from '../core/output-file'
import { fromPixels } from '../core/units'
import { selectAndroidDevice } from '../drivers/android/devices'
import { captureAndroid } from '../drivers/android/screenshot'

export const screenshotCommand = defineCommand({
  name: 'screenshot',
  summary: 'Save the screen as a PNG file, upright in each orientation',
  input: z.object({
    out: z
      .string()
      .min(1)
      .describe(
        'The PNG file to write. loupe makes its folder, and replaces a file that is there.',
      ),
    app: appField,
    device: deviceField,
  }),
  positionals: ['out'],
  output: displaySchema.extend({
    file: z.string().describe('The PNG file, as an absolute path.'),
  }),
  run: async ({ out, app, device }, context) => {
    const { png, pixels, display } = await captureAndroid(
      await selectAndroidDevice(context, device),
      app,
    )

    const file = await writeOutputFile(out, png)

    return {
      file,
      orientation: display.orientation,
      size: {
        width: fromPixels(pixels.width, display.scale),
        height: fromPixels(pixels.height, display.scale),
      },
      pixels,
      scale: display.scale,
    }
  },
  format: (shot) => `Saved ${shot.file}\n${describeDisplay(shot)}`,
})
