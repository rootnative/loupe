import { setTimeout as sleep } from 'node:timers/promises'
import { type DisplayState, rotationOf } from '../../core/display'
import { LoupeError } from '../../core/errors'
import { type Point } from '../../core/units'
import { type AndroidTarget, EMULATOR_SERIAL } from './devices'

/** The emulator's touchscreen reports 0 to 32767 on each axis. */
const RAW_UNITS = 32768
const PRESSURE = 50

/**
 * True for an emulator that adb can reach the console of: `adb emu` takes the
 * console port from an `emulator-<port>` serial.
 */
export function hasConsole(target: AndroidTarget): boolean {
  return target.kind === 'emulator' && EMULATOR_SERIAL.test(target.serial)
}

/** Fails unless the target has a console that adb can reach. */
export function needsConsole(target: AndroidTarget, gesture: string): void {
  if (target.kind !== 'emulator') {
    throw new LoupeError(
      'unsupported',
      `${gesture} works only on an emulator: it goes through the emulator console, and ${target.serial} is a real device.`,
    )
  }
  if (!hasConsole(target)) {
    throw new LoupeError(
      'unsupported',
      `${gesture} goes through the emulator console, and adb reaches it only for a serial like emulator-5554, not ${target.serial}.`,
    )
  }
}

function rawUnit(pixels: number, size: number): number {
  return Math.min(Math.floor((pixels * RAW_UNITS) / size), RAW_UNITS - 1)
}

/**
 * A point in px of the current orientation, in the console's raw units. The
 * units span the screen in its natural orientation, and Android turns them
 * by the rotation, so this turns the point back first.
 */
export function toRaw(
  { x, y }: Point,
  { orientation, pixels }: Pick<DisplayState, 'orientation' | 'pixels'>,
): Point {
  const { width, height } = pixels
  const natural = (() => {
    switch (rotationOf(orientation)) {
      case 1:
        return { x: height - y, y: x, width: height, height: width }
      case 2:
        return { x: width - x, y: height - y, width, height }
      case 3:
        return { x: y, y: width - x, width: height, height: width }
      default:
        return { x, y, width, height }
    }
  })()
  return {
    x: rawUnit(natural.x, natural.width),
    y: rawUnit(natural.y, natural.height),
  }
}

export function downEvents(fingers: readonly Point[]): string[] {
  return [
    ...fingers.flatMap(({ x, y }, slot) => [
      `EV_ABS:ABS_MT_SLOT:${slot}`,
      `EV_ABS:ABS_MT_TRACKING_ID:${slot + 1}`,
      `EV_ABS:ABS_MT_POSITION_X:${x}`,
      `EV_ABS:ABS_MT_POSITION_Y:${y}`,
      `EV_ABS:ABS_MT_PRESSURE:${PRESSURE}`,
    ]),
    'EV_KEY:BTN_TOUCH:1',
    'EV_SYN:0:0',
  ]
}

export function moveEvents(fingers: readonly Point[]): string[] {
  return [
    ...fingers.flatMap(({ x, y }, slot) => [
      `EV_ABS:ABS_MT_SLOT:${slot}`,
      `EV_ABS:ABS_MT_POSITION_X:${x}`,
      `EV_ABS:ABS_MT_POSITION_Y:${y}`,
    ]),
    'EV_SYN:0:0',
  ]
}

export function upEvents(count: number): string[] {
  return [
    ...Array.from({ length: count }, (_, slot) => [
      `EV_ABS:ABS_MT_SLOT:${slot}`,
      'EV_ABS:ABS_MT_TRACKING_ID:-1',
    ]).flat(),
    'EV_KEY:BTN_TOUCH:0',
    'EV_SYN:0:0',
  ]
}

async function send(
  target: AndroidTarget,
  events: readonly string[],
): Promise<void> {
  const reply = await target.adb.text(['emu', 'event', 'send', ...events])
  // adb exits with 0 when the console refuses a command: only the reply
  // tells.
  const refused = reply.split(/\r?\n/).find((line) => line.startsWith('KO'))
  if (refused) {
    throw new LoupeError(
      'tool_failed',
      `The emulator console of ${target.serial} refused the touch. ${refused.trim()}`,
    )
  }
}

/** Moves the fingers that are down to new points, in raw units. */
export type MoveFingers = (fingers: readonly Point[]) => Promise<void>

/**
 * Puts the fingers down, runs `body`, and lifts them after it, also when it
 * fails. Each console call takes every finger. The raw units come from
 * `toRaw`.
 */
export async function whileDown<T>(
  target: AndroidTarget,
  fingers: readonly Point[],
  body: (move: MoveFingers) => Promise<T>,
): Promise<T> {
  let value: T
  try {
    await send(target, downEvents(fingers))
    value = await body((next) => send(target, moveEvents(next)))
  } catch (error) {
    // A finger that stays down blocks the app, so the lift goes out first.
    await send(target, upEvents(fingers.length)).catch(() => {})
    throw error
  }
  await send(target, upEvents(fingers.length))
  return value
}

/** Waits on the host. */
export async function pause(ms: number): Promise<void> {
  if (ms > 0) await sleep(ms)
}

/**
 * Puts the fingers down at the first step, waits `wait` ms before each next
 * step, and lifts them after the last. Returns the milliseconds from the
 * touch to the last step, measured on the host.
 */
export function consoleGesture(
  target: AndroidTarget,
  steps: readonly (readonly Point[])[],
  wait: number,
): Promise<number> {
  const [first = [], ...next] = steps
  return whileDown(target, first, async (move) => {
    const start = performance.now()
    for (const fingers of next) {
      await pause(wait)
      await move(fingers)
    }
    return Math.round(performance.now() - start)
  })
}
