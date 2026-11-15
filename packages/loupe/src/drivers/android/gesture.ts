import { LoupeError } from '../../core/errors'
import { DEFAULT_TIMEOUT_MS } from '../../core/exec'
import { pngSize } from '../../core/png'
import { type Touch } from '../../core/touch'
import { type Point } from '../../core/units'
import { type AndroidTarget } from './devices'
import { onScreen, screenInFront } from './touch'

/** On Android 11, each `input` call starts a Java process: over 500 ms. */
const MIN_API_LEVEL = 31
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
  /** Milliseconds between the two taps, measured on the device. */
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
  /** Milliseconds that the move took, measured on the device. */
  moveTime: number
  png?: Buffer
}

function needsFastInput(target: AndroidTarget, gesture: string): void {
  if (target.apiLevel < MIN_API_LEVEL) {
    throw new LoupeError(
      'unsupported',
      `${gesture} needs Android 12 (API level ${MIN_API_LEVEL}) or later. ${target.serial} runs API level ${target.apiLevel}, where one input call takes over 500 ms.`,
    )
  }
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

export async function doubleTapAndroid(
  target: AndroidTarget,
  at: Point,
  app?: string,
): Promise<DoubleTap> {
  needsFastInput(target, 'A double-tap')
  const display = await screenInFront(target, app)
  const pixels = onScreen(display, at)
  const tap = `input tap ${pixels.x} ${pixels.y} || echo ${FAILED}`

  const output = await runScript(
    target,
    [tap, stamp('first'), ...pause(DOUBLE_TAP_PAUSE_MS), tap, stamp('second')],
    DEFAULT_TIMEOUT_MS,
  )

  // Each stamp comes right after an `input` call ends, and each call sends
  // its events at its end. So this is the gap from the first lift to the
  // second touch, to within a few ms.
  const gap = between(output, 'first', 'second')
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

async function readShot(
  target: AndroidTarget,
  output: string,
  app: string | undefined,
): Promise<Buffer> {
  try {
    if (output.includes(SHOT_REFUSED)) {
      throw new LoupeError(
        'app_not_in_front',
        `The focus moved away from ${app} during the drag, so loupe took no screenshot.`,
      )
    }
    if (!output.includes(SHOT_TAKEN)) {
      throw new LoupeError(
        'tool_failed',
        `screencap failed on ${target.serial} during the drag.`,
      )
    }
    const png = await target.adb.run(['exec-out', 'cat', SHOT_FILE])
    if (!pngSize(png)) {
      throw new LoupeError(
        'tool_failed',
        `The screenshot of the drag on ${target.serial} isn't a PNG.`,
      )
    }
    return png
  } finally {
    // The file can only hold the app under test, so a failed delete doesn't
    // fail the drag.
    await target.adb.run(['shell', 'rm', '-f', SHOT_FILE]).catch(() => {})
  }
}

/**
 * A touch that holds, moves in steps, holds, and lifts, as one script. The
 * script waits `duration` across the steps, and each `input` call adds its
 * own time, so the move takes at least `duration`. A screenshot in the move
 * pauses the touch at that point while it runs.
 */
export async function dragAndroid(
  target: AndroidTarget,
  from: Point,
  to: Point,
  options: DragOptions,
  app?: string,
): Promise<Drag> {
  needsFastInput(target, 'A drag')
  const { duration, holdStart, holdEnd, shotAt } = options
  const display = await screenInFront(target, app)
  const start = onScreen(display, from)
  const end = onScreen(display, to)

  const motion = (action: string, { x, y }: Point): string =>
    `input motionevent ${action} ${x} ${y} || echo ${FAILED}`
  const shotStep =
    shotAt === undefined
      ? undefined
      : shotAt === 1
        ? 'end'
        : Math.round(shotAt * DRAG_STEPS)
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
    orientation: display.orientation,
    points: [from, to],
    pixels: [start, end],
    duration,
    holdStart,
    holdEnd,
    moveTime: between(output, 'move', 'moved'),
    png:
      shotStep === undefined ? undefined : await readShot(target, output, app),
  }
}
