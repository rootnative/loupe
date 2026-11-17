import { LoupeError } from './errors'
import {
  cropImage,
  decodePng,
  encodePng,
  type Image,
  PngError,
  scaleDown,
} from './png'
import { type Rect, rectFromPixels, round2, type Size } from './units'

/** A crop as the CLI takes it: x,y,width,height in dp. */
export const CROP_PATTERN = /^\d+(\.\d+)?(,\d+(\.\d+)?){3}$/

export function parseCrop(text: string): Rect {
  const [x = 0, y = 0, width = 0, height = 0] = text.split(',').map(Number)
  return { x, y, width, height }
}

/**
 * Decodes a PNG that a capture tool gave. A PNG that loupe can't read gives
 * `unsupported` or `tool_failed`.
 */
export function decodeCapture(png: Buffer): Image {
  try {
    return decodePng(png)
  } catch (error) {
    if (!(error instanceof PngError)) throw error
    throw new LoupeError(
      error.kind === 'unsupported' ? 'unsupported' : 'tool_failed',
      `loupe can't read the screenshot. ${error.message}`,
    )
  }
}

export interface ShotChange {
  /** In dp of the current orientation. */
  crop?: Rect
  /** More than 0, at most 1. */
  scale?: number
}

export interface ChangedShot {
  png: Buffer
  /** The size of the new PNG, in px. */
  image: Size
  /** The part of the screen in the new PNG, in dp, inside the screen. */
  crop?: Rect
}

function clamp(value: number, max: number): number {
  return Math.min(Math.max(value, 0), max)
}

/**
 * Crops and scales down an upright screenshot. The crop snaps to whole
 * pixels, and the part outside the screen is left out; a crop with no part
 * on the screen gives `invalid_input`.
 */
export function changeShot(
  png: Buffer,
  displayScale: number,
  { crop, scale }: ShotChange,
): ChangedShot {
  let image = decodeCapture(png)
  let used: Rect | undefined

  if (crop) {
    const px = (dp: number, max: number) =>
      clamp(Math.round(dp * displayScale), max)
    const left = px(crop.x, image.width)
    const top = px(crop.y, image.height)
    const right = px(crop.x + crop.width, image.width)
    const bottom = px(crop.y + crop.height, image.height)
    if (right <= left || bottom <= top) {
      const screen = `${round2(image.width / displayScale)} × ${round2(image.height / displayScale)} dp`
      throw new LoupeError(
        'invalid_input',
        `The crop ${crop.x},${crop.y},${crop.width},${crop.height} has no part on the screen, which is ${screen}.`,
      )
    }
    const rect = { x: left, y: top, width: right - left, height: bottom - top }
    image = cropImage(image, rect)
    used = rectFromPixels(rect, displayScale)
  }
  if (scale !== undefined) image = scaleDown(image, scale)

  return {
    png: encodePng(image),
    image: { width: image.width, height: image.height },
    crop: used,
  }
}
