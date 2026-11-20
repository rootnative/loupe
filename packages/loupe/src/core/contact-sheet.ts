import { type Image, scaleDown } from './png'

/** One screen of a contact sheet. */
export interface SheetCell {
  /** The number in the cell's badge: a whole number, 0 or more. */
  number: number
  /** The screenshot, at any size. */
  image: Image
  /** A rule failed on this screen: the cell gets a red frame and badge. */
  failed?: boolean
}

export interface SheetOptions {
  /** The width of each thumbnail, in px. Default: 240. */
  thumbnailWidth?: number
  /** Default: as many as fit in `maxWidth`, and at least 1. */
  columns?: number
  /** The widest sheet when `columns` isn't set, in px. Default: 1600. */
  maxWidth?: number
}

type Colour = readonly [number, number, number]

const BACKGROUND: Colour = [32, 32, 32]
const FRAME: Colour = [117, 117, 117]
const FAILED: Colour = [211, 47, 47]
const BADGE: Colour = [0, 0, 0]
const DIGIT: Colour = [255, 255, 255]

/** Around the sheet and between two cells, in px. */
const GAP = 8
/** The frame around each thumbnail, in px. */
const FRAME_WIDTH = 4
/** The side of one font dot, in px. */
const DOT = 3
/** Around the digits in the badge, in px. */
const BADGE_PAD = 4

const GLYPH_WIDTH = 3
const GLYPH_HEIGHT = 5

// 3 × 5 dots for each digit, row by row from the top.
const GLYPHS = [
  '111101101101111',
  '010110010010111',
  '111001111100111',
  '111001111001111',
  '101101111001001',
  '111100111001111',
  '111100111101111',
  '111001001001001',
  '111101111101111',
  '111101111001111',
] as const

function fill(
  sheet: Image,
  left: number,
  top: number,
  width: number,
  height: number,
  [red, green, blue]: Colour,
): void {
  const right = Math.min(sheet.width, left + width)
  const bottom = Math.min(sheet.height, top + height)
  for (let y = Math.max(0, top); y < bottom; y += 1) {
    for (let x = Math.max(0, left); x < right; x += 1) {
      const at = (y * sheet.width + x) * 4
      sheet.data[at] = red
      sheet.data[at + 1] = green
      sheet.data[at + 2] = blue
      sheet.data[at + 3] = 255
    }
  }
}

/** Copies the image onto the sheet. Its alpha becomes opaque. */
function paste(sheet: Image, image: Image, left: number, top: number): void {
  for (let y = 0; y < image.height; y += 1) {
    const to = ((top + y) * sheet.width + left) * 4
    sheet.data.set(
      image.data.subarray(y * image.width * 4, (y + 1) * image.width * 4),
      to,
    )
    for (let x = 0; x < image.width; x += 1) sheet.data[to + x * 4 + 3] = 255
  }
}

/** The number on a badge, with its top left corner at the point. */
function badge(
  sheet: Image,
  left: number,
  top: number,
  number: number,
  colour: Colour,
): void {
  const digits = String(number)
  const width = BADGE_PAD * 2 + digits.length * (GLYPH_WIDTH + 1) * DOT - DOT
  fill(sheet, left, top, width, BADGE_PAD * 2 + GLYPH_HEIGHT * DOT, colour)

  for (const [index, digit] of [...digits].entries()) {
    const glyph = GLYPHS[Number(digit)] ?? ''
    const x = left + BADGE_PAD + index * (GLYPH_WIDTH + 1) * DOT
    for (const [dot, on] of [...glyph].entries()) {
      if (on !== '1') continue
      fill(
        sheet,
        x + (dot % GLYPH_WIDTH) * DOT,
        top + BADGE_PAD + Math.floor(dot / GLYPH_WIDTH) * DOT,
        DOT,
        DOT,
        DIGIT,
      )
    }
  }
}

/**
 * One image with a thumbnail of each screen, row by row, for a fast look at
 * many screens. Each cell has its number on a badge in the top left corner,
 * in a built-in digit font, and a frame: red when a rule failed there. A
 * thumbnail keeps the shape of its screenshot, and a screenshot narrower
 * than the thumbnail width keeps its size.
 */
export function contactSheet(
  cells: readonly SheetCell[],
  { thumbnailWidth = 240, columns, maxWidth = 1600 }: SheetOptions = {},
): Image {
  if (cells.length === 0) throw new RangeError('A contact sheet needs a cell.')
  for (const { number } of cells) {
    if (!Number.isInteger(number) || number < 0) {
      throw new RangeError(`${number} isn't a whole number, 0 or more.`)
    }
  }

  const thumbnails = cells.map(({ image }) =>
    scaleDown(image, Math.min(1, thumbnailWidth / image.width)),
  )
  const cellWidth =
    Math.max(...thumbnails.map(({ width }) => width)) + FRAME_WIDTH * 2
  const cellHeight =
    Math.max(...thumbnails.map(({ height }) => height)) + FRAME_WIDTH * 2
  const fit = Math.floor((maxWidth - GAP) / (cellWidth + GAP))
  const perRow = Math.min(cells.length, Math.max(1, columns ?? fit))
  const rows = Math.ceil(cells.length / perRow)

  const width = GAP + perRow * (cellWidth + GAP)
  const height = GAP + rows * (cellHeight + GAP)
  const sheet = { width, height, data: new Uint8Array(width * height * 4) }
  fill(sheet, 0, 0, width, height, BACKGROUND)

  for (const [index, cell] of cells.entries()) {
    const thumbnail = thumbnails[index]
    if (!thumbnail) continue
    const left = GAP + (index % perRow) * (cellWidth + GAP)
    const top = GAP + Math.floor(index / perRow) * (cellHeight + GAP)
    const colour = cell.failed ? FAILED : FRAME
    fill(
      sheet,
      left,
      top,
      thumbnail.width + FRAME_WIDTH * 2,
      thumbnail.height + FRAME_WIDTH * 2,
      colour,
    )
    paste(sheet, thumbnail, left + FRAME_WIDTH, top + FRAME_WIDTH)
    badge(sheet, left, top, cell.number, cell.failed ? FAILED : BADGE)
  }
  return sheet
}
