import path from 'node:path'
import { z } from 'zod'
import { type ScreenCheck, screenCheckSchema } from './check'
import { contactSheet, type SheetCell } from './contact-sheet'
import { ORIENTATIONS, type Orientation } from './display'
import { ERROR_CODES, LoupeError } from './errors'
import { writeOutputFile } from './output-file'
import { decodePng, encodePng, type Image, scaleDown } from './png'

/** The themes that a sweep can set. */
export const SWEEP_THEMES = ['light', 'dark'] as const

export type SweepTheme = (typeof SWEEP_THEMES)[number]

/** The width of each thumbnail of a contact sheet, in px. */
const THUMBNAIL_WIDTH = 240
/** The cell of a screen with no screenshot, in px. */
const NO_SHOT = { width: THUMBNAIL_WIDTH, height: 427 }

export interface DeviceLook {
  orientation: Orientation
  /** The theme setting: light, dark, or what the platform has besides. */
  theme: string
}

/** What a sweep needs from a device. Each call is for the app under test. */
export interface SweepDriver {
  look(): Promise<DeviceLook>
  open(url: string): Promise<void>
  /** Turns the screen when it isn't in this orientation. */
  rotate(orientation: Orientation): Promise<void>
  /** Sets the theme when it isn't this one. Gives its warnings. */
  setTheme(theme: SweepTheme): Promise<string[]>
  /** Waits until the screen keeps still; `timeout` when it doesn't. */
  waitStill(): Promise<void>
  /** Runs the rules, and takes the screenshot of the checked screen. */
  check(): Promise<{ check: ScreenCheck; png: Buffer }>
  /** A screenshot alone, for a screen that loupe couldn't check. */
  capture(): Promise<Buffer>
  /** Puts back what the sweep changed. Gives a warning for what stays. */
  restore(
    look: DeviceLook,
    changed: { orientation: boolean; theme: boolean },
  ): Promise<string[]>
}

export interface SweepInput {
  urls: readonly string[]
  /** Left out: only the orientation that the device has. */
  orientations?: readonly Orientation[]
  /** Left out: only the theme that the device has. */
  themes?: readonly SweepTheme[]
  /** The folder for the report, the screenshots and the contact sheets. */
  out: string
}

export const sweepScreenSchema = z.object({
  number: z
    .number()
    .describe(
      'The place of the link in the list, from 1: the number of its cell on each contact sheet, and of its screenshot file.',
    ),
  url: z.string(),
  variant: z.string().describe('The orientation and the theme: portrait-dark.'),
  passed: z
    .boolean()
    .describe('True when loupe checked the screen and every rule passed.'),
  check: screenCheckSchema
    .optional()
    .describe('The result of each rule, as `check` gives it.'),
  error: z
    .object({ code: z.enum(ERROR_CODES), message: z.string() })
    .optional()
    .describe(
      'Why loupe could not check this screen. The sweep went on with the next one.',
    ),
  screenshot: z
    .string()
    .optional()
    .describe('The file. Left out when loupe could take no screenshot.'),
  warnings: z.array(z.string()),
  ms: z.number().describe('Milliseconds for this screen, from the open.'),
})

export type SweepScreen = z.infer<typeof sweepScreenSchema>

export const sweepVariantSchema = z.object({
  name: z.string().describe('The orientation and the theme: portrait-dark.'),
  orientation: z.enum(ORIENTATIONS),
  theme: z.string().describe('light or dark, or the setting of the device.'),
  sheet: z
    .string()
    .describe(
      'The contact sheet: a thumbnail of each screen with its number, in a red frame when the screen failed.',
    ),
  screens: z.number(),
  failed: z.number(),
})

export type SweepVariant = z.infer<typeof sweepVariantSchema>

export const sweepReportSchema = z.object({
  out: z.string().describe('The folder with each file of the sweep.'),
  passed: z.boolean().describe('True when every screen passed.'),
  variants: z.array(sweepVariantSchema),
  screens: z.array(sweepScreenSchema),
  warnings: z.array(z.string()),
})

export type SweepReport = z.infer<typeof sweepReportSchema>

/** `03`, or `003` from 100 links: the files sort in the order of the list. */
function fileNumber(number: number, count: number): string {
  return String(number).padStart(Math.max(2, String(count).length), '0')
}

/** The thumbnail of a screenshot, or none when loupe can't decode it. */
function thumbnailOf(png: Buffer | undefined): Image | undefined {
  if (!png) return undefined
  try {
    const image = decodePng(png)
    return scaleDown(image, Math.min(1, THUMBNAIL_WIDTH / image.width))
  } catch {
    return undefined
  }
}

/** A dark cell, for a screen with no screenshot. */
function blank({ width, height }: { width: number; height: number }): Image {
  const data = new Uint8Array(width * height * 4)
  for (let at = 3; at < data.length; at += 4) data[at] = 255
  return { width, height, data }
}

/**
 * Opens each link in each variant (orientation × theme), waits until the
 * screen keeps still, runs the rules and keeps the screenshot. A screen
 * that loupe can't open or check gets its error in the report, and the
 * sweep goes on. At the end it writes one contact sheet for each variant
 * and `report.json`, and puts the orientation and the theme back.
 */
export async function sweep(
  driver: SweepDriver,
  { urls, orientations, themes, out }: SweepInput,
): Promise<SweepReport> {
  const folder = path.resolve(out)
  const start = await driver.look()
  const screens: SweepScreen[] = []
  const variants: SweepVariant[] = []
  const warnings: string[] = []

  try {
    for (const orientation of orientations ?? [start.orientation]) {
      for (const theme of themes ?? [start.theme]) {
        const name = `${orientation}-${theme}`
        const cells: (SheetCell | { number: number; failed: true })[] = []
        let failed = 0

        for (const [index, url] of urls.entries()) {
          const number = index + 1
          const began = Date.now()
          const screen: SweepScreen = {
            number,
            url,
            variant: name,
            passed: false,
            warnings: [],
            ms: 0,
          }
          let png: Buffer | undefined
          try {
            await driver.open(url)
            if (orientations) await driver.rotate(orientation)
            if (themes) {
              screen.warnings.push(
                ...(await driver.setTheme(theme as SweepTheme)),
              )
            }
            await driver.waitStill()
            const checked = await driver.check()
            png = checked.png
            screen.check = checked.check
            screen.passed = checked.check.passed
          } catch (error) {
            if (!(error instanceof LoupeError)) throw error
            screen.error = { code: error.code, message: error.message }
            png = await driver.capture().catch(() => undefined)
          }

          if (png) {
            screen.screenshot = await writeOutputFile(
              path.join(folder, name, `${fileNumber(number, urls.length)}.png`),
              png,
            )
          }
          screen.ms = Date.now() - began
          screens.push(screen)
          if (!screen.passed) failed += 1

          const image = thumbnailOf(png)
          cells.push(
            image
              ? { number, image, failed: !screen.passed }
              : { number, failed: true },
          )
        }

        const size = cells.find((cell) => 'image' in cell)?.image ?? NO_SHOT
        const sheet = contactSheet(
          cells.map((cell) =>
            'image' in cell ? cell : { ...cell, image: blank(size) },
          ),
          { thumbnailWidth: THUMBNAIL_WIDTH },
        )
        variants.push({
          name,
          orientation,
          theme,
          sheet: await writeOutputFile(
            path.join(folder, `${name}.png`),
            encodePng(sheet),
          ),
          screens: urls.length,
          failed,
        })
      }
    }
  } finally {
    warnings.push(
      ...(await driver.restore(start, {
        orientation: orientations !== undefined,
        theme: themes !== undefined,
      })),
    )
  }

  const report: SweepReport = {
    out: folder,
    passed: screens.every((screen) => screen.passed),
    variants,
    screens,
    warnings,
  }
  await writeOutputFile(
    path.join(folder, 'report.json'),
    Buffer.from(`${JSON.stringify(report, null, 2)}\n`),
  )
  return report
}
