export type Platform = 'ios' | 'android'

/** Device points: pt on iOS, dp on Android. */
export type Unit = 'pt' | 'dp'

export interface Point {
  x: number
  y: number
}

export interface Size {
  width: number
  height: number
}

/** The origin is the top-left corner of the current orientation. */
export interface Rect extends Point, Size {}

export interface Insets {
  top: number
  right: number
  bottom: number
  left: number
}

export function unitOf(platform: Platform): Unit {
  return platform === 'ios' ? 'pt' : 'dp'
}

/** Pixels are whole numbers, so the result is rounded. */
export function toPixels(value: number, scale: number): number {
  return Math.round(value * scale)
}

/** Not rounded: 1080 px at scale 2.625 is 411.43 dp, and a check needs it. */
export function fromPixels(pixels: number, scale: number): number {
  return pixels / scale
}

export function pointToPixels(point: Point, scale: number): Point {
  return { x: toPixels(point.x, scale), y: toPixels(point.y, scale) }
}

export function rectFromPixels(rect: Rect, scale: number): Rect {
  return {
    x: fromPixels(rect.x, scale),
    y: fromPixels(rect.y, scale),
    width: fromPixels(rect.width, scale),
    height: fromPixels(rect.height, scale),
  }
}

export function rectRight(rect: Rect): number {
  return rect.x + rect.width
}

export function rectBottom(rect: Rect): number {
  return rect.y + rect.height
}

export function rectCentre(rect: Rect): Point {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
}

/**
 * True when `inner` is fully inside `outer`. `tolerance` lets `inner` run
 * past each edge by that much, for sub-pixel rounding.
 */
export function containsRect(outer: Rect, inner: Rect, tolerance = 0): boolean {
  return (
    inner.x >= outer.x - tolerance &&
    inner.y >= outer.y - tolerance &&
    rectRight(inner) <= rectRight(outer) + tolerance &&
    rectBottom(inner) <= rectBottom(outer) + tolerance
  )
}

/** The shared area of two rects, or null when they only touch or are apart. */
export function intersection(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x)
  const y = Math.max(a.y, b.y)
  const width = Math.min(rectRight(a), rectRight(b)) - x
  const height = Math.min(rectBottom(a), rectBottom(b)) - y

  return width > 0 && height > 0 ? { x, y, width, height } : null
}

/** The safe area: the screen with its insets removed. */
export function insetRect(screen: Size, insets: Insets): Rect {
  return {
    x: insets.left,
    y: insets.top,
    width: Math.max(0, screen.width - insets.left - insets.right),
    height: Math.max(0, screen.height - insets.top - insets.bottom),
  }
}
