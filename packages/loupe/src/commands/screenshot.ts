import { z } from 'zod'
import { defineCommand } from '../core/command'
import { appField, deviceField } from '../core/device'
import { describeDisplay, displaySchema } from '../core/display'
import { writeOutputFile } from '../core/output-file'
import { changeShot, CROP_PATTERN, parseCrop } from '../core/screenshot'
import { rectSchema } from '../core/ui'
import { fromPixels, round2 } from '../core/units'
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
    crop: z
      .string()
      .regex(
        CROP_PATTERN,
        'A crop is x,y,width,height in dp, for example 0,0,411,64.',
      )
      .optional()
      .describe(
        'Save only this part of the screen: x,y,width,height in dp, from the top-left corner of the current orientation. The part outside the screen is left out.',
      ),
    scale: z
      .number()
      .gt(0)
      .max(1)
      .optional()
      .describe(
        'Scale the image down by this factor, for example 0.5 for half the width and half the height. A smaller file costs fewer tokens.',
      ),
    app: appField,
    device: deviceField,
  }),
  positionals: ['out'],
  output: displaySchema.extend({
    file: z.string().describe('The PNG file, as an absolute path.'),
    image: z
      .object({ width: z.number(), height: z.number() })
      .describe(
        'The size of the PNG file, in px: the screen, or the crop, after the scale.',
      ),
    crop: rectSchema
      .optional()
      .describe(
        'The part of the screen in the file, in dp, snapped to whole pixels. Left out with no crop.',
      ),
  }),
  run: async ({ out, crop, scale, app, device }, context) => {
    const capture = await captureAndroid(
      await selectAndroidDevice(context, device),
      app,
    )
    const { pixels, display } = capture
    const changed =
      crop !== undefined || (scale !== undefined && scale < 1)
        ? changeShot(capture.png, display.scale, {
            crop: crop === undefined ? undefined : parseCrop(crop),
            scale,
          })
        : { png: capture.png, image: pixels, crop: undefined }

    const file = await writeOutputFile(out, changed.png)

    return {
      file,
      orientation: display.orientation,
      size: {
        width: fromPixels(pixels.width, display.scale),
        height: fromPixels(pixels.height, display.scale),
      },
      pixels,
      scale: display.scale,
      image: changed.image,
      crop: changed.crop,
    }
  },
  images: (shot) => [shot.file],
  format: (shot) => {
    const lines = [`Saved ${shot.file}`, describeDisplay(shot)]
    if (shot.crop) {
      const { x, y, width, height } = shot.crop
      lines.push(
        `Crop: (${round2(x)}, ${round2(y)}) ${round2(width)} × ${round2(height)} dp`,
      )
    }
    if (
      shot.image.width !== shot.pixels.width ||
      shot.image.height !== shot.pixels.height
    ) {
      lines.push(`Image: ${shot.image.width} × ${shot.image.height} px`)
    }
    return lines.join('\n')
  },
})
