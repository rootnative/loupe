import { type CommandContext } from '../core/context'
import { LoupeError } from '../core/errors'
import {
  type AndroidTarget,
  readyAndroidDevices,
  selectAndroidDevice,
} from './android/devices'
import { hasSimulators, readSimulators } from './ios/devices'
import { type SimulatorEntry } from './ios/parse'

/** The one iOS simulator that a command works on. */
export interface IosTarget {
  udid: string
  name: string
  /** The runtime, for example `iOS 18.6`. */
  os: string
  /** The `signal` of the command's context: each wait loop stops on it. */
  signal?: AbortSignal
}

export type SelectedDevice =
  | { platform: 'android'; target: AndroidTarget }
  | { platform: 'ios'; target: IosTarget }

const BOOTED = 'Booted'

const describe = ({ name, udid, os }: SimulatorEntry): string =>
  `${name} (${udid}, ${os})`

/** The value when the tools of the platform work, else `fallback`. */
async function orWhenFails<T>(promise: Promise<T>, fallback: T): Promise<T> {
  try {
    return await promise
  } catch (error) {
    if (error instanceof LoupeError) return fallback
    throw error
  }
}

function ios(
  context: CommandContext,
  { udid, name, os }: SimulatorEntry,
): SelectedDevice {
  return {
    platform: 'ios',
    target: { udid, name, os, signal: context.signal },
  }
}

async function android(
  context: CommandContext,
  wanted?: string,
): Promise<SelectedDevice> {
  return {
    platform: 'android',
    target: await selectAndroidDevice(context, wanted),
  }
}

function notRunning(simulator: SimulatorEntry): LoupeError {
  return new LoupeError(
    'device_unavailable',
    simulator.state === 'Booting'
      ? `The simulator ${describe(simulator)} is still booting. Wait until it's ready, then try again.`
      : `The simulator ${describe(simulator)} doesn't run. Start it, then try again.`,
  )
}

/** The simulator with the name `wanted`: the one of them that runs. */
function byName(
  named: readonly SimulatorEntry[],
  wanted: string,
): SimulatorEntry {
  const booted = named.filter((simulator) => simulator.state === BOOTED)
  if (booted.length > 1) {
    throw new LoupeError(
      'device_ambiguous',
      `${booted.length} simulators with the name "${wanted}" run: ${booted.map(describe).join(', ')}. Give the UDID of one in the "device" option.`,
    )
  }
  const [only] = booted
  if (only) return only
  const [first] = named
  if (named.length === 1 && first) throw notRunning(first)
  throw new LoupeError(
    'device_unavailable',
    `No simulator with the name "${wanted}" runs. Start one, then try again.`,
  )
}

async function selectNamed(
  context: CommandContext,
  wanted: string,
): Promise<SelectedDevice> {
  const simulators = await orWhenFails(readSimulators(context), [])
  const byUdid = simulators.find(
    (simulator) => simulator.udid.toLowerCase() === wanted.toLowerCase(),
  )
  if (byUdid) {
    if (byUdid.state !== BOOTED) throw notRunning(byUdid)
    return ios(context, byUdid)
  }

  try {
    return await android(context, wanted)
  } catch (error) {
    // No such Android device, or no Android SDK: `wanted` can still be the
    // name of a simulator.
    const open =
      error instanceof LoupeError &&
      (error.code === 'no_device' || error.code === 'tool_missing')
    if (!open) throw error
    const named = simulators.filter((simulator) => simulator.name === wanted)
    if (named.length > 0) return ios(context, byName(named, wanted))
    if (error.code === 'tool_missing') throw error
    throw new LoupeError(
      'no_device',
      `No device has the serial, the AVD name, the UDID or the simulator name "${wanted}". Run "loupe devices" to see the list.`,
    )
  }
}

async function selectOnly(context: CommandContext): Promise<SelectedDevice> {
  const booted = (await orWhenFails(readSimulators(context), [])).filter(
    (simulator) => simulator.state === BOOTED,
  )
  if (booted.length === 0) {
    try {
      return await android(context)
    } catch (error) {
      if (error instanceof LoupeError && error.code === 'no_device') {
        throw new LoupeError(
          'no_device',
          'loupe finds no Android device, no running emulator and no running iOS simulator. Start one or connect a device, then try again.',
        )
      }
      throw error
    }
  }

  const ready = await orWhenFails(readyAndroidDevices(context), [])
  const [only] = booted
  if (ready.length === 0 && booted.length === 1 && only) {
    return ios(context, only)
  }
  throw new LoupeError(
    'device_ambiguous',
    `${ready.length + booted.length} devices are ready: ${[...ready, ...booted.map(describe)].join(', ')}. Choose one with the "device" option.`,
  )
}

/**
 * Finds the device for a command over both platforms. `wanted` names it: a
 * UDID of a simulator, else a serial or an AVD name of an Android device,
 * else the name of a simulator. With no name, it's the device in
 * ANDROID_SERIAL, else the only ready device of both platforms. A system
 * that isn't macOS has only Android devices, and asks only their tools.
 */
export async function selectDevice(
  context: CommandContext,
  wanted?: string,
): Promise<SelectedDevice> {
  if (!hasSimulators(context)) return android(context, wanted)
  if (wanted) return selectNamed(context, wanted)
  if (context.env.ANDROID_SERIAL) return android(context)
  return selectOnly(context)
}

/**
 * The device for a command that works only on Android so far. An iOS
 * simulator gives `unsupported`. Keep the list of commands in its message
 * true when a command gets its iOS part.
 */
export async function selectAndroidOnly(
  context: CommandContext,
  wanted?: string,
): Promise<AndroidTarget> {
  const selected = await selectDevice(context, wanted)
  if (selected.platform === 'android') return selected.target
  const { name, udid, os } = selected.target
  throw new LoupeError(
    'unsupported',
    `This command doesn't work on an iOS simulator yet: only "devices" and "screenshot" do. The device is ${name} (${udid}, ${os}). For an Android device, give its serial or its AVD name in the "device" option.`,
  )
}
