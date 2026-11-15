import { LoupeError } from '../../core/errors'
import { type InsetsReading, maxInsets, NO_INSETS } from '../../core/insets'
import {
  type Insets,
  intersection,
  rectFromPixels,
  type Size,
} from '../../core/units'
import { type AndroidTarget } from './devices'
import { dumpWindowDisplays, toDisplayState, windowDisplayOf } from './display'
import { isAppWindow } from './foreground'
import { type InsetSource, parseWindowInsets } from './parse'

/** The source types of the system bars, in the names of each API level. */
const SYSTEM_BARS = new Set([
  'statusBars',
  'navigationBars',
  'captionBar',
  'ITYPE_STATUS_BAR',
  'ITYPE_CLIMATE_BAR',
  'ITYPE_NAVIGATION_BAR',
  'ITYPE_EXTRA_NAVIGATION_BAR',
  'ITYPE_CAPTION_BAR',
])

const EXPO_GO = 'host.exp.exponent'
const LETTERBOX_MAX_API_LEVEL = 34

/**
 * The inset that one source gives, in px, by Android's rule: a source that
 * spans the whole width or height insets the edge that it touches. Any
 * other source insets the edge of its side hint (API 35+), or none.
 */
export function insetOf(source: InsetSource, screen: Size): Insets {
  const frame = intersection(source.frame, { x: 0, y: 0, ...screen })
  if (!frame) return NO_INSETS

  const fullWidth = frame.width === screen.width
  const fullHeight = frame.height === screen.height
  const right = frame.x + frame.width
  const bottom = frame.y + frame.height
  if (fullWidth && !fullHeight) {
    if (frame.y === 0) return { ...NO_INSETS, top: frame.height }
    if (bottom === screen.height) return { ...NO_INSETS, bottom: frame.height }
  }
  if (fullHeight && !fullWidth) {
    if (frame.x === 0) return { ...NO_INSETS, left: frame.width }
    if (right === screen.width) return { ...NO_INSETS, right: frame.width }
  }
  switch (source.sideHint) {
    case 'TOP':
      return { ...NO_INSETS, top: bottom }
    case 'BOTTOM':
      return { ...NO_INSETS, bottom: screen.height - frame.y }
    case 'LEFT':
      return { ...NO_INSETS, left: right }
    case 'RIGHT':
      return { ...NO_INSETS, right: screen.width - frame.x }
    default:
      return NO_INSETS
  }
}

function insetsInDp(insets: Insets, scale: number): Insets {
  return {
    top: insets.top / scale,
    right: insets.right / scale,
    bottom: insets.bottom / scale,
    left: insets.left / scale,
  }
}

/**
 * The insets of the display in the current orientation, from `dumpsys
 * window displays`. These are the system's numbers: an app that keeps its
 * window out of the cutout sees less.
 */
export async function readAndroidInsets(
  target: AndroidTarget,
): Promise<InsetsReading> {
  const dump = await dumpWindowDisplays(target)
  const window = windowDisplayOf(target, dump)
  const insets = parseWindowInsets(dump)
  if (!insets) {
    throw new LoupeError(
      'tool_failed',
      `loupe can't read the insets of ${target.serial} from "dumpsys window displays".`,
    )
  }

  const display = toDisplayState(window)
  const systemBars = maxInsets(
    insets.sources
      .filter((source) => source.visible && SYSTEM_BARS.has(source.type))
      .map((source) => insetOf(source, window.current)),
  )
  const sideCutout = insets.cutout.left > 0 || insets.cutout.right > 0

  const warnings: string[] = []
  if (
    isAppWindow(window.focus, EXPO_GO) &&
    target.apiLevel <= LETTERBOX_MAX_API_LEVEL &&
    display.orientation.startsWith('landscape') &&
    sideCutout
  ) {
    warnings.push(
      'Expo Go on Android 14 and lower keeps its window out of a side cutout in landscape, with a black bar there. The app sees no side inset, so these side insets are not what the app gets.',
    )
  }

  return {
    ...display,
    source: 'dumpsys',
    safeArea: insetsInDp(maxInsets([systemBars, insets.cutout]), display.scale),
    systemBars: insetsInDp(systemBars, display.scale),
    cutout: insetsInDp(insets.cutout, display.scale),
    cutoutRects: insets.cutoutRects.map((rect) =>
      rectFromPixels(rect, display.scale),
    ),
    warnings,
  }
}
