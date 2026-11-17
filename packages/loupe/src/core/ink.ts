import { type Image, type PixelRect } from './png'

/**
 * A pixel is ink when one of its channels differs from the background by
 * more than this. Less is the soft edge of a glyph.
 */
export const INK_TOLERANCE = 32

/** A range of px columns: from `from` up to, not including, `to`. */
export interface ColumnSpan {
  from: number
  to: number
}

function packed(data: Uint8Array, index: number): number {
  return (
    ((data[index] ?? 0) << 24) |
    ((data[index + 1] ?? 0) << 16) |
    ((data[index + 2] ?? 0) << 8) |
    (data[index + 3] ?? 0)
  )
}

/**
 * The columns of `rect` that hold ink, for example where the glyphs of a
 * text are inside its frame. The background is the commonest colour on the
 * border of `rect`. A pixel inside one of `masks` doesn't count: another
 * element draws there. Null when no pixel is ink, or each border pixel is
 * masked.
 */
export function inkColumns(
  image: Image,
  rect: PixelRect,
  masks: readonly PixelRect[] = [],
): ColumnSpan | null {
  const left = Math.max(0, rect.x)
  const top = Math.max(0, rect.y)
  const right = Math.min(image.width, rect.x + rect.width)
  const bottom = Math.min(image.height, rect.y + rect.height)
  if (right <= left || bottom <= top) return null

  // The masked columns of each row, as [start, end) pairs.
  const maskedIn = (y: number) =>
    masks
      .filter((mask) => y >= mask.y && y < mask.y + mask.height)
      .map((mask) => [mask.x, mask.x + mask.width] as const)
  const isMasked = (x: number, spans: ReturnType<typeof maskedIn>) =>
    spans.some(([start, end]) => x >= start && x < end)

  const counts = new Map<number, number>()
  const count = (x: number, y: number, spans: ReturnType<typeof maskedIn>) => {
    if (isMasked(x, spans)) return
    const colour = packed(image.data, (y * image.width + x) * 4)
    counts.set(colour, (counts.get(colour) ?? 0) + 1)
  }
  for (const y of new Set([top, bottom - 1])) {
    const spans = maskedIn(y)
    for (let x = left; x < right; x += 1) count(x, y, spans)
  }
  for (let y = top + 1; y < bottom - 1; y += 1) {
    const spans = maskedIn(y)
    count(left, y, spans)
    if (right - 1 > left) count(right - 1, y, spans)
  }
  let background: number | undefined
  let most = 0
  for (const [colour, seen] of counts) {
    if (seen > most) {
      background = colour
      most = seen
    }
  }
  if (background === undefined) return null

  const channels = [
    (background >>> 24) & 0xff,
    (background >>> 16) & 0xff,
    (background >>> 8) & 0xff,
    background & 0xff,
  ]
  let from = right
  let to = left
  for (let y = top; y < bottom; y += 1) {
    const spans = maskedIn(y)
    for (let x = left; x < right; x += 1) {
      if (x >= from && x < to) continue
      if (isMasked(x, spans)) continue
      const index = (y * image.width + x) * 4
      const ink = channels.some(
        (channel, offset) =>
          Math.abs((image.data[index + offset] ?? 0) - channel) > INK_TOLERANCE,
      )
      if (ink) {
        from = Math.min(from, x)
        to = Math.max(to, x + 1)
      }
    }
  }
  return to > from ? { from, to } : null
}
