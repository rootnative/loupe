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

/** A scroll view that `scroll` moved down, to bring back to its top. */
export interface Scrolled {
  /** Gives a warning when the top doesn't come back. */
  back(): Promise<string[]>
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
  /**
   * Scrolls the largest vertical scroll view down once. Gives undefined
   * when the screen has none, or when the view doesn't move.
   */
  scroll(): Promise<Scrolled | undefined>
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
  /** Also check each screen after one scroll down. */
  scroll?: boolean
}

export const sweepScreenSchema = z.object({
  number: z
    .number()
    .describe(
      'The place of the link in the list, from 1: the number of its cell on each contact sheet, and of its screenshot file.',
    ),
  url: z.string(),
  variant: z.string().describe('The orientation and the theme: portrait-dark.'),
  scrolled: z
    .boolean()
    .describe(
      'True for the check after one scroll down. It comes right after the check of its link at the top.',
    ),
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
  ms: z
    .number()
    .describe(
      'Milliseconds for this screen, from the open, or from the scroll for a scrolled screen.',
    ),
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
  scrolledSheet: z
    .string()
    .optional()
    .describe(
      'The contact sheet of the scrolled screens, each with the number of its link. Left out when no screen scrolled.',
    ),
  screens: z
    .number()
    .describe('The screens checked: one for each link, and each scrolled one.'),
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

type Cell = SheetCell | { number: number; failed: true }

/** One contact sheet: each cell with no screenshot is dark. */
async function writeSheet(file: string, cells: readonly Cell[]) {
  const size = cells.find((cell) => 'image' in cell)?.image ?? NO_SHOT
  const sheet = contactSheet(
    cells.map((cell) =>
      'image' in cell ? cell : { ...cell, image: blank(size) },
    ),
    { thumbnailWidth: THUMBNAIL_WIDTH },
  )
  return writeOutputFile(file, encodePng(sheet))
}

/** Keeps a loupe error in the screen, and takes a screenshot if it can. */
async function failedScreen(
  driver: SweepDriver,
  screen: SweepScreen,
  error: unknown,
): Promise<Buffer | undefined> {
  if (!(error instanceof LoupeError)) throw error
  screen.error = { code: error.code, message: error.message }
  return driver.capture().catch(() => undefined)
}

/**
 * Runs `before`, waits until the screen keeps still, and checks it. Gives
 * the screenshot.
 */
async function checkScreen(
  driver: SweepDriver,
  screen: SweepScreen,
  before: () => Promise<void> = async () => {},
): Promise<Buffer | undefined> {
  try {
    await before()
    await driver.waitStill()
    const checked = await driver.check()
    screen.check = checked.check
    screen.passed = checked.check.passed
    return checked.png
  } catch (error) {
    return failedScreen(driver, screen, error)
  }
}

/**
 * Scrolls once, checks the screen, and scrolls back to the top: the next
 * variant opens the same link, and the app can show the same screen. Gives
 * undefined when the screen didn't scroll.
 */
async function checkScrolled(
  driver: SweepDriver,
  screen: SweepScreen,
): Promise<{ png?: Buffer } | undefined> {
  let scrolled: Scrolled | undefined
  try {
    scrolled = await driver.scroll()
  } catch (error) {
    return { png: await failedScreen(driver, screen, error) }
  }
  if (!scrolled) return undefined

  const png = await checkScreen(driver, screen)
  try {
    screen.warnings.push(...(await scrolled.back()))
  } catch (error) {
    if (!(error instanceof LoupeError)) throw error
    screen.warnings.push(
      `loupe couldn't scroll back to the top, so the next check of this link can start lower down: ${error.message}`,
    )
  }
  return { png }
}

/**
 * Opens each link in each variant (orientation × theme), waits until the
 * screen keeps still, runs the rules and keeps the screenshot. With
 * `scroll`, it also checks each screen after one scroll down, then
 * scrolls back. A screen that loupe can't open or check gets its error in
 * the report, and the sweep goes on. At the end it writes the contact
 * sheets of each variant and `report.json`, and puts the orientation and
 * the theme back.
 */
export async function sweep(
  driver: SweepDriver,
  { urls, orientations, themes, out, scroll }: SweepInput,
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
        const topCells: Cell[] = []
        const scrolledCells: Cell[] = []
        let count = 0
        let failed = 0

        const keep = async (
          screen: SweepScreen,
          png: Buffer | undefined,
          began: number,
        ) => {
          if (png) {
            const file = `${fileNumber(screen.number, urls.length)}${screen.scrolled ? '-scrolled' : ''}.png`
            screen.screenshot = await writeOutputFile(
              path.join(folder, name, file),
              png,
            )
          }
          screen.ms = Date.now() - began
          screens.push(screen)
          count += 1
          if (!screen.passed) failed += 1

          const image = thumbnailOf(png)
          const { number } = screen
          const cells = screen.scrolled ? scrolledCells : topCells
          cells.push(
            image
              ? { number, image, failed: !screen.passed }
              : { number, failed: true },
          )
        }

        for (const [index, url] of urls.entries()) {
          const screenOf = (scrolled: boolean): SweepScreen => ({
            number: index + 1,
            url,
            variant: name,
            scrolled,
            passed: false,
            warnings: [],
            ms: 0,
          })

          const opened = Date.now()
          const top = screenOf(false)
          const png = await checkScreen(driver, top, async () => {
            await driver.open(url)
            if (orientations) await driver.rotate(orientation)
            if (themes) {
              top.warnings.push(...(await driver.setTheme(theme as SweepTheme)))
            }
          })
          await keep(top, png, opened)
          if (!scroll || top.error) continue

          const began = Date.now()
          const below = screenOf(true)
          const shown = await checkScrolled(driver, below)
          if (shown) await keep(below, shown.png, began)
        }

        variants.push({
          name,
          orientation,
          theme,
          sheet: await writeSheet(path.join(folder, `${name}.png`), topCells),
          ...(scrolledCells.length > 0
            ? {
                scrolledSheet: await writeSheet(
                  path.join(folder, `${name}-scrolled.png`),
                  scrolledCells,
                ),
              }
            : {}),
          screens: count,
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
