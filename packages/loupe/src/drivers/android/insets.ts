import { type DisplayState } from '../../core/display'
import { LoupeError } from '../../core/errors'
import {
  differingEdges,
  type InsetsReading,
  maxInsets,
  NO_INSETS,
} from '../../core/insets'
import { type ProbeReading } from '../../core/probe'
import {
  type Insets,
  intersection,
  rectFromPixels,
  round2,
  type Size,
} from '../../core/units'
import { type AndroidTarget } from './devices'
import { dumpWindowDisplays, toDisplayState, windowDisplayOf } from './display'
import { type InsetSource, parseWindowInsets } from './parse'
import { type AndroidUi, readAndroidUi } from './ui'

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

export type SystemInsets = Omit<InsetsReading, 'source' | 'warnings'>

/**
 * The insets of the display in the current orientation, from `dumpsys
 * window displays`. These are the system's numbers: an app whose window
 * keeps out of a bar or the cutout sees less.
 */
export async function readSystemInsets(
  target: AndroidTarget,
): Promise<SystemInsets> {
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

  return {
    ...display,
    safeArea: insetsInDp(maxInsets([systemBars, insets.cutout]), display.scale),
    systemBars: insetsInDp(systemBars, display.scale),
    cutout: insetsInDp(insets.cutout, display.scale),
    cutoutRects: insets.cutoutRects.map((rect) =>
      rectFromPixels(rect, display.scale),
    ),
  }
}

const SYSTEM_NUMBERS = "These are the system's insets."

interface FoundProbe {
  display: DisplayState
  probe?: ProbeReading
}

/**
 * Reads the screen to find the probe. Undefined, with a warning, when
 * loupe may not read the screen, or when the screen never keeps still.
 */
async function findProbe(
  target: AndroidTarget,
  app: string | undefined,
  warnings: string[],
): Promise<FoundProbe | undefined> {
  if (target.kind === 'device' && !app) {
    warnings.push(
      `loupe didn't look for the app's probe: on a real device, it reads the screen only with the "app" option. ${SYSTEM_NUMBERS}`,
    )
    return undefined
  }
  try {
    const ui = await readAndroidUi(target, app)
    return { display: ui.display, probe: ui.probe }
  } catch (error) {
    if (error instanceof LoupeError && error.code === 'not_idle') {
      warnings.push(
        `The screen didn't keep still, so loupe couldn't look for the app's probe. ${SYSTEM_NUMBERS}`,
      )
      return undefined
    }
    throw error
  }
}

function mismatchWarning(
  app: Insets,
  system: Insets,
  scale: number,
): string | undefined {
  // The probe gives float32 dp, and dumpsys whole px: less than half a
  // pixel apart is the same inset.
  const edges = differingEdges(app, system, 0.5 / scale)
  if (edges.length === 0) return undefined
  const numbers = edges
    .map(
      (edge) =>
        `${edge} ${round2(app[edge])} dp in the app, ${round2(system[edge])} dp from the system`,
    )
    .join('; ')
  return `The app's safe area isn't the system's: ${numbers}. The app's window can keep out of a bar or the cutout, or the app can be a moment behind a rotate.`
}

/**
 * The safe area that the app gets, from the probe when the screen shows
 * one (`source: "probe"`), else the system's (`source: "dumpsys"`). The
 * system bars and the cutout always come from `dumpsys`. A real device
 * needs `app` for the probe; with `app`, loupe reads only while that app
 * is in front.
 */
export async function readAndroidInsets(
  target: AndroidTarget,
  app?: string,
): Promise<InsetsReading> {
  const warnings: string[] = []
  const found = await findProbe(target, app, warnings)
  return combineInsets(target, found, warnings)
}

/**
 * The insets of the screen that `ui` read, with no second dump: the probe
 * comes from `ui`, the rest from `dumpsys`.
 */
export function insetsOfUi(
  target: AndroidTarget,
  ui: AndroidUi,
): Promise<InsetsReading> {
  return combineInsets(target, { display: ui.display, probe: ui.probe }, [])
}

async function combineInsets(
  target: AndroidTarget,
  found: FoundProbe | undefined,
  warnings: string[],
): Promise<InsetsReading> {
  const system = await readSystemInsets(target)
  if (found && found.display.orientation !== system.orientation) {
    throw new LoupeError(
      'tool_failed',
      `The screen turned while loupe read the insets. Wait until it's still, then try again.`,
    )
  }

  warnings.push(...(found?.probe?.warnings ?? []))
  const report = found?.probe?.report
  if (report && !report.insets) {
    warnings.push(
      `The app's probe has no SafeAreaProvider above it, so it gives no insets. ${SYSTEM_NUMBERS}`,
    )
  }
  if (!report?.insets) return { ...system, source: 'dumpsys', warnings }

  const mismatch = mismatchWarning(report.insets, system.safeArea, system.scale)
  if (mismatch) warnings.push(mismatch)
  return { ...system, source: 'probe', safeArea: report.insets, warnings }
}
