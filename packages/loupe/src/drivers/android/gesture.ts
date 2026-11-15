import { type DisplayState } from '../../core/display'
import { LoupeError } from '../../core/errors'
import { DEFAULT_TIMEOUT_MS } from '../../core/exec'
import { pngSize } from '../../core/png'
import { type Touch } from '../../core/touch'
import { type Point } from '../../core/units'
import {
  hasConsole,
  pause as hostPause,
  needsConsole,
  toRaw,
  whileDown,
} from './console'
import { type AndroidTarget } from './devices'
import { readWindowDisplay } from './display'
import { isAppWindow } from './foreground'
import { onScreen, screenInFront } from './touch'

/**
 * On a busy emulator `input` loses the timing, and the console keeps it: in
 * CI, an `input` drag of 300 ms took 3.6 s. On Android 11, each `input` call
 * also starts a Java process: over 500 ms. So `input` runs only from API 31,
 * and only where there's no console: on a real device or an emulator over
 * TCP.
 */
const MIN_INPUT_API_LEVEL = 31
const DOUBLE_TAP_PAUSE_MS = 100
/** Android's GestureDetector takes a double-tap only in this gap, in ms. */
const DOUBLE_TAP_MIN_MS = 40
const DOUBLE_TAP_MAX_MS = 300
const DRAG_STEPS = 10
const SHOT_FILE = '/data/local/tmp/loupe-drag.png'

// Each line of a gesture script ends with a marker on failure, not with an
// exit: the script must always reach the UP, or the touch stays down.
const FAILED = 'loupe-failed'
const SHOT_TAKEN = 'loupe-shot'
const SHOT_REFUSED = 'loupe-not-in-front'

export interface DoubleTap extends Touch {
  /**
   * Milliseconds between the two taps, measured on the device, or on the
   * host through the emulator console.
   */
  gap: number
}

export interface DragOptions {
  /** Milliseconds for the move, at the least. */
  duration: number
  holdStart: number
  holdEnd: number
  /** 0 to 1 along the move. With no value, there's no screenshot. */
  shotAt?: number
}

export interface Drag extends Touch {
  holdStart: number
  holdEnd: number
  /**
   * Milliseconds that the move took, measured on the device, or on the host
   * through the emulator console.
   */
  moveTime: number
  png?: Buffer
}

/** True when the gesture goes through the emulator console. */
function overConsole(target: AndroidTarget, gesture: string): boolean {
  if (target.apiLevel >= MIN_INPUT_API_LEVEL) return hasConsole(target)
  needsConsole(target, `${gesture} on API level ${target.apiLevel}`)
  return true
}

function stamp(name: string): string {
  return `echo "loupe-stamp ${name} $EPOCHREALTIME"`
}

function pause(ms: number): string[] {
  return ms > 0 ? [`sleep ${(ms / 1000).toFixed(3)}`] : []
}

function between(output: string, from: string, to: string): number {
  const stamps = new Map(
    [...output.matchAll(/^loupe-stamp (\S+) (\d+(?:\.\d+)?)\s*$/gm)].map(
      ([, name, seconds]) => [name, Number(seconds) * 1000],
    ),
  )
  const start = stamps.get(from)
  const end = stamps.get(to)
  if (start === undefined || end === undefined) {
    throw new LoupeError(
      'tool_failed',
      "loupe can't read the time stamps of the gesture from the device.",
    )
  }
  return Math.round(end - start)
}

/** Runs the lines in one shell on the device, so no host trip makes a gap. */
async function runScript(
  target: AndroidTarget,
  lines: readonly string[],
  timeout: number,
): Promise<string> {
  const output = await target.adb.text(['shell', lines.join('; ')], {
    timeout,
  })
  if (output.includes(FAILED)) {
    throw new LoupeError(
      'tool_failed',
      `An input call failed on ${target.serial} during the gesture.`,
    )
  }
  return output
}

async function inputDoubleTap(
  target: AndroidTarget,
  { x, y }: Point,
): Promise<number> {
  const tap = `input tap ${x} ${y} || echo ${FAILED}`
  const output = await runScript(
    target,
    [tap, stamp('first'), ...pause(DOUBLE_TAP_PAUSE_MS), tap, stamp('second')],
    DEFAULT_TIMEOUT_MS,
  )
  // Each stamp comes right after an `input` call ends, and each call sends
  // its events at its end. So this is the gap from the first lift to the
  // second touch, to within a few ms.
  return between(output, 'first', 'second')
}

/**
 * Two taps, each a touch and a lift. Each console call returns after the
 * emulator took its events, so the gap is right to within one call.
 */
async function consoleDoubleTap(
  target: AndroidTarget,
  finger: Point,
): Promise<number> {
  await whileDown(target, [finger], async () => {})
  const lifted = performance.now()
  await hostPause(DOUBLE_TAP_PAUSE_MS)
  return whileDown(target, [finger], async () =>
    Math.round(performance.now() - lifted),
  )
}

export async function doubleTapAndroid(
  target: AndroidTarget,
  at: Point,
  app?: string,
): Promise<DoubleTap> {
  const viaConsole = overConsole(target, 'A double-tap')
  const display = await screenInFront(target, app)
  const pixels = onScreen(display, at)

  const gap = viaConsole
    ? await consoleDoubleTap(target, toRaw(pixels, display))
    : await inputDoubleTap(target, pixels)
  if (gap > DOUBLE_TAP_MAX_MS) {
    throw new LoupeError(
      'timeout',
      `The two taps were ${gap} ms apart, more than the ${DOUBLE_TAP_MAX_MS} ms of a double-tap, so the app saw two taps.`,
    )
  }
  if (gap < DOUBLE_TAP_MIN_MS) {
    throw new LoupeError(
      'tool_failed',
      `The two taps were only ${gap} ms apart, so the pause between them didn't work. A double-tap needs ${DOUBLE_TAP_MIN_MS} to ${DOUBLE_TAP_MAX_MS} ms.`,
    )
  }
  return {
    orientation: display.orientation,
    points: [at],
    pixels: [pixels],
    gap,
  }
}

/**
 * The screenshot command. With `app`, it checks the focus again first: the
 * touch can start a system gesture, for example Home from the bottom edge,
 * and the next screen can show the user's other apps.
 */
function shotLine(app: string | undefined): string {
  const take = `screencap -p ${SHOT_FILE} && echo ${SHOT_TAKEN}`
  if (!app) return take
  const focus = `u[0-9]* ${app.replaceAll('.', '\\.')}[/}]`
  return `if dumpsys window displays | grep -m 1 mCurrentFocus= | grep -q '${focus}'; then ${take}; else echo ${SHOT_REFUSED}; fi`
}

function stepsOf(start: Point, end: Point): Point[] {
  return Array.from({ length: DRAG_STEPS }, (_, index) => {
    const part = (index + 1) / DRAG_STEPS
    return {
      x: Math.round(start.x + (end.x - start.x) * part),
      y: Math.round(start.y + (end.y - start.y) * part),
    }
  })
}

function focusMoved(app: string | undefined): LoupeError {
  return new LoupeError(
    'app_not_in_front',
    `The focus moved away from ${app} during the drag, so loupe took no screenshot.`,
  )
}

function checkPng(target: AndroidTarget, png: Buffer): Buffer {
  if (!pngSize(png)) {
    throw new LoupeError(
      'tool_failed',
      `The screenshot of the drag on ${target.serial} isn't a PNG.`,
    )
  }
  return png
}

async function readShot(
  target: AndroidTarget,
  output: string,
  app: string | undefined,
): Promise<Buffer> {
  try {
    if (output.includes(SHOT_REFUSED)) throw focusMoved(app)
    if (!output.includes(SHOT_TAKEN)) {
      throw new LoupeError(
        'tool_failed',
        `screencap failed on ${target.serial} during the drag.`,
      )
    }
    return checkPng(
      target,
      await target.adb.run(['exec-out', 'cat', SHOT_FILE]),
    )
  } finally {
    // The file can only hold the app under test, so a failed delete doesn't
    // fail the drag.
    await target.adb.run(['shell', 'rm', '-f', SHOT_FILE]).catch(() => {})
  }
}

function shotStepOf(shotAt: number | undefined): number | 'end' | undefined {
  if (shotAt === undefined) return undefined
  return shotAt === 1 ? 'end' : Math.round(shotAt * DRAG_STEPS)
}

interface Moved {
  moveTime: number
  png?: Buffer
}

/**
 * A touch that holds, moves in steps, holds, and lifts, as one script. The
 * script waits `duration` across the steps, and each `input` call adds its
 * own time, so the move takes at least `duration`. A screenshot in the move
 * pauses the touch at that point while it runs.
 */
async function inputDrag(
  target: AndroidTarget,
  start: Point,
  end: Point,
  { duration, holdStart, holdEnd, shotAt }: DragOptions,
  app: string | undefined,
): Promise<Moved> {
  const motion = (action: string, { x, y }: Point): string =>
    `input motionevent ${action} ${x} ${y} || echo ${FAILED}`
  const shotStep = shotStepOf(shotAt)
  const shot = shotLine(app)
  const shotAfter = (step: number | 'end'): string[] =>
    shotStep === step ? [shot] : []

  const lines = [
    motion('DOWN', start),
    ...pause(holdStart),
    ...shotAfter(0),
    stamp('move'),
    ...stepsOf(start, end).flatMap((point, index) => [
      motion('MOVE', point),
      ...pause(duration / DRAG_STEPS),
      ...shotAfter(index + 1),
    ]),
    stamp('moved'),
    ...pause(holdEnd),
    ...shotAfter('end'),
    motion('UP', end),
  ]

  const output = await runScript(
    target,
    lines,
    holdStart + duration + holdEnd + DEFAULT_TIMEOUT_MS,
  )
  return {
    moveTime: between(output, 'move', 'moved'),
    png:
      shotStep === undefined ? undefined : await readShot(target, output, app),
  }
}

/**
 * The same drag through the emulator console, in the same order. The
 * screenshot runs from the host while the finger stays down. When it fails,
 * the drag still ends first, as in the script.
 */
async function consoleDrag(
  target: AndroidTarget,
  display: DisplayState,
  start: Point,
  end: Point,
  { duration, holdStart, holdEnd, shotAt }: DragOptions,
  app: string | undefined,
): Promise<Moved> {
  const shotStep = shotStepOf(shotAt)
  const finger = (point: Point): Point[] => [toRaw(point, display)]
  let png: Buffer | undefined
  let shotError: unknown

  const shotAfter = async (step: number | 'end'): Promise<void> => {
    if (shotStep !== step) return
    try {
      if (app && !isAppWindow((await readWindowDisplay(target)).focus, app)) {
        throw focusMoved(app)
      }
      png = checkPng(
        target,
        await target.adb.run(['exec-out', 'screencap', '-p']),
      )
    } catch (error) {
      shotError = error
    }
  }

  const moveTime = await whileDown(target, finger(start), async (move) => {
    await hostPause(holdStart)
    await shotAfter(0)
    const moving = performance.now()
    for (const [index, point] of stepsOf(start, end).entries()) {
      await move(finger(point))
      await hostPause(duration / DRAG_STEPS)
      await shotAfter(index + 1)
    }
    const moved = Math.round(performance.now() - moving)
    await hostPause(holdEnd)
    await shotAfter('end')
    return moved
  })
  if (shotError) throw shotError
  return { moveTime, png }
}

export async function dragAndroid(
  target: AndroidTarget,
  from: Point,
  to: Point,
  options: DragOptions,
  app?: string,
): Promise<Drag> {
  const viaConsole = overConsole(target, 'A drag')
  const display = await screenInFront(target, app)
  const start = onScreen(display, from)
  const end = onScreen(display, to)

  const { moveTime, png } = viaConsole
    ? await consoleDrag(target, display, start, end, options, app)
    : await inputDrag(target, start, end, options, app)
  return {
    orientation: display.orientation,
    points: [from, to],
    pixels: [start, end],
    duration: options.duration,
    holdStart: options.holdStart,
    holdEnd: options.holdEnd,
    moveTime,
    png,
  }
}
