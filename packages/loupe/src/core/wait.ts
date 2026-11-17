import { setTimeout as sleep } from 'node:timers/promises'
import { z } from 'zod'
import { describeElement, type Element, elementSchema } from './element'
import { LoupeError } from './errors'
import { type Image, type PixelRect } from './png'
import { round2 } from './units'

export const DEFAULT_WAIT_TIMEOUT = 10_000
export const DEFAULT_WAIT_INTERVAL = 250

export const timeoutField = z
  .number()
  .int()
  .min(0)
  .max(600_000)
  .optional()
  .describe(
    `How long to wait at most, in ms. ${DEFAULT_WAIT_TIMEOUT} by default.`,
  )

/** The wait options of each action: the wait runs after the action. */
export const waitFields = {
  waitStill: z
    .boolean()
    .optional()
    .describe(
      'Then wait until the screen keeps still: two equal screenshots in a row, with the system bars left out.',
    ),
  waitText: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Then wait until an element with this text (the whole text) is on the screen. With waitStill too, this wait comes first.',
    ),
  waitTimeout: timeoutField,
}

export interface WaitInput {
  waitStill?: boolean
  waitText?: string
  waitTimeout?: number
}

export const waitedSchema = z.object({
  ms: z.number().describe('How long the wait took, in ms.'),
  frames: z
    .number()
    .optional()
    .describe('The screenshots taken until the screen kept still.'),
  reads: z
    .number()
    .optional()
    .describe('The reads of the tree until the element was on the screen.'),
  element: elementSchema
    .optional()
    .describe('The first element on the screen with the text, label or id.'),
})

export type Waited = z.infer<typeof waitedSchema>

export interface WaitOptions {
  timeout: number
  interval: number
}

/**
 * True when the two images have the same size and the same pixels inside
 * `region`.
 */
export function sameRegion(a: Image, b: Image, region: PixelRect): boolean {
  if (a.width !== b.width || a.height !== b.height) return false
  const bytes = (image: Image, y: number) => {
    const start = (y * image.width + region.x) * 4
    return Buffer.from(
      image.data.buffer,
      image.data.byteOffset + start,
      region.width * 4,
    )
  }
  for (let y = region.y; y < region.y + region.height; y += 1) {
    if (!bytes(a, y).equals(bytes(b, y))) return false
  }
  return true
}

/** One screenshot: the PNG, and its pixels once something needs them. */
interface Frame {
  png: Buffer
  image?: Image
}

export interface StillSource {
  /** Takes one PNG of the screen. */
  take(): Promise<Buffer>
  decode(png: Buffer): Image
  /** The part of the image to compare: the screen with no system bars. */
  regionOf(image: Image): Promise<PixelRect>
}

export interface StillResult {
  still: boolean
  frames: number
  ms: number
}

/**
 * Takes screenshots until two in a row are the same inside the region, for
 * up to `timeout` ms. It takes two at least. Equal PNG bytes need no
 * decode.
 */
export async function waitForStill(
  source: StillSource,
  { timeout, interval }: WaitOptions,
): Promise<StillResult> {
  const start = Date.now()
  const pixels = (frame: Frame) => (frame.image ??= source.decode(frame.png))

  let previous: Frame = { png: await source.take() }
  let frames = 1
  for (;;) {
    await sleep(interval)
    const current: Frame = { png: await source.take() }
    frames += 1
    let still = current.png.equals(previous.png)
    if (!still) {
      const image = pixels(current)
      still = sameRegion(pixels(previous), image, await source.regionOf(image))
    }
    const ms = Date.now() - start
    if (still || ms >= timeout) return { still, frames, ms }
    previous = current
  }
}

export interface ElementResult {
  /** Left out when no element came in time. */
  element?: Element
  reads: number
  ms: number
  /** The last error that the wait went past, for the message. */
  lastError?: LoupeError
}

/** The errors that mean "not there yet": the wait goes on past them. */
const PASSING = new Set(['not_idle', 'app_not_in_front'])

/**
 * Reads the screen until `find` gives an element, for up to `timeout` ms.
 * A screen that doesn't keep still, or another app in front, counts as
 * "not yet".
 */
export async function waitForElement(
  find: () => Promise<Element | undefined>,
  { timeout, interval }: WaitOptions,
): Promise<ElementResult> {
  const start = Date.now()
  let reads = 0
  let lastError: LoupeError | undefined
  for (;;) {
    reads += 1
    try {
      const element = await find()
      if (element) return { element, reads, ms: Date.now() - start }
    } catch (error) {
      if (!(error instanceof LoupeError && PASSING.has(error.code))) throw error
      lastError = error
    }
    const ms = Date.now() - start
    if (ms >= timeout) return { reads, ms, lastError }
    await sleep(interval)
  }
}

export function notStill({ frames, ms }: StillResult): string {
  return `the screen didn't keep still in ${ms} ms (${frames} screenshots). An animation that never stops can cause this; take a screenshot instead.`
}

export function noElement(what: string, result: ElementResult): string {
  const why = result.lastError
    ? ` The last read said: ${result.lastError.message}`
    : ''
  return `no element with the ${what} came on the screen in ${result.ms} ms (${result.reads} reads).${why}`
}

/** The summary of an action, and a "Then waited …" line when it waited. */
export function withWaited(summary: string, waited?: Waited): string {
  return waited ? `${summary}\nThen ${describeWaited(waited)}.` : summary
}

/**
 * For a person, with no capital and no full stop: `waited 2.1 s for
 * "Title" (3 reads), then until still (2 screenshots)`.
 */
export function describeWaited({ ms, frames, reads, element }: Waited): string {
  const parts: string[] = []
  if (element) {
    parts.push(`for ${describeElement(element)} (${reads ?? 1} reads)`)
  }
  if (frames !== undefined) parts.push(`until still (${frames} screenshots)`)
  return `waited ${round2(ms / 1000)} s ${parts.join(', then ')}`
}
