import { elementsOnScreen, type Selector } from '../../core/element'
import { LoupeError } from '../../core/errors'
import { type Image, type PixelRect } from '../../core/png'
import { decodeCapture } from '../../core/screenshot'
import {
  DEFAULT_WAIT_INTERVAL,
  DEFAULT_WAIT_TIMEOUT,
  type ElementResult,
  noElement,
  notStill,
  type StillResult,
  type WaitInput,
  type Waited,
  waitForElement,
  waitForStill,
  type WaitOptions,
} from '../../core/wait'
import { type AndroidTarget } from './devices'
import { readSystemInsets, type SystemInsets } from './insets'
import { captureAndroid } from './screenshot'
import { readAndroidUi } from './ui'

/** The image with no system bars, in px: the clock ticks in the status bar. */
function withoutBars(
  image: Image,
  { systemBars, scale }: SystemInsets,
): PixelRect {
  const px = (dp: number) => Math.round(dp * scale)
  const x = px(systemBars.left)
  const y = px(systemBars.top)
  return {
    x,
    y,
    width: Math.max(0, image.width - x - px(systemBars.right)),
    height: Math.max(0, image.height - y - px(systemBars.bottom)),
  }
}

/**
 * Takes screenshots until two in a row are the same, with the system bars
 * left out, only while `app` is in front. The bars come from `dumpsys`,
 * read again when the screen turns.
 */
export function waitStillAndroid(
  target: AndroidTarget,
  app: string | undefined,
  options: WaitOptions,
): Promise<StillResult> {
  let insets: SystemInsets | undefined
  return waitForStill(
    {
      take: async () => (await captureAndroid(target, app)).png,
      decode: decodeCapture,
      regionOf: async (image) => {
        if (
          insets?.pixels.width !== image.width ||
          insets.pixels.height !== image.height
        ) {
          insets = await readSystemInsets(target)
        }
        return withoutBars(image, insets)
      },
    },
    options,
  )
}

/** Reads the tree until an element that `selector` names is on the screen. */
export function waitForElementAndroid(
  target: AndroidTarget,
  app: string | undefined,
  selector: Selector,
  options: WaitOptions,
): Promise<ElementResult> {
  return waitForElement(async () => {
    const ui = await readAndroidUi(target, app)
    return elementsOnScreen(ui.nodes, selector, ui.display.size)[0]
  }, options)
}

/**
 * The wait after an action: for the text first, then for a still screen,
 * both inside one timeout. A wait that runs out gives `timeout`, and its
 * message says that the action ran.
 */
export async function waitAfterAction(
  target: AndroidTarget,
  app: string | undefined,
  { waitStill, waitText, waitTimeout = DEFAULT_WAIT_TIMEOUT }: WaitInput,
  action: string,
): Promise<Waited | undefined> {
  if (!waitStill && waitText === undefined) return undefined

  const start = Date.now()
  const interval = DEFAULT_WAIT_INTERVAL
  const waited: Waited = { ms: 0 }
  if (waitText !== undefined) {
    const found = await waitForElementAndroid(
      target,
      app,
      { by: 'text', value: waitText },
      { timeout: waitTimeout, interval },
    )
    if (!found.element) {
      throw new LoupeError(
        'timeout',
        `The ${action} ran, but ${noElement(`text ${JSON.stringify(waitText)}`, found)}`,
      )
    }
    waited.element = found.element
    waited.reads = found.reads
  }
  if (waitStill) {
    const timeout = Math.max(0, waitTimeout - (Date.now() - start))
    const still = await waitStillAndroid(target, app, { timeout, interval })
    if (!still.still) {
      throw new LoupeError(
        'timeout',
        `The ${action} ran, but ${notStill(still)}`,
      )
    }
    waited.frames = still.frames
  }
  waited.ms = Date.now() - start
  return waited
}
