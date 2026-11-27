import { type CommandContext } from '../../core/context'
import {
  type Device,
  type DeviceList,
  type DeviceState,
} from '../../core/device'
import { LoupeError } from '../../core/errors'
import { type Adb, createAdb } from './adb'
import {
  type AdbDeviceEntry,
  parseAdbDevices,
  parseAvdList,
  parseEmuAvdName,
  parseGetprop,
} from './parse'
import { createSdkTool, EMULATOR, type SdkTool } from './sdk-tool'

/** Android 11. The insets format of `dumpsys` that loupe reads starts here. */
export const MIN_API_LEVEL = 30

export const EMULATOR_SERIAL = /^emulator-\d+$/

type Props = Record<string, string>

/** The one device that a command works on. */
export interface AndroidTarget {
  serial: string
  kind: 'emulator' | 'device'
  apiLevel: number
  /** adb with `-s <serial>` before each command. */
  adb: SdkTool
  /** The `signal` of the command's context: each wait loop stops on it. */
  signal?: AbortSignal
}

type Attempt<T> = { value: T } | { error: string }

/** Turns a `LoupeError` into a result, so one device can't fail the list. */
async function attempt<T>(promise: Promise<T>): Promise<Attempt<T>> {
  try {
    return { value: await promise }
  } catch (error) {
    if (error instanceof LoupeError) return { error: error.message }
    throw error
  }
}

function valueOf<T>(result: Attempt<T> | undefined): T | undefined {
  return result && 'value' in result ? result.value : undefined
}

function stateOf(adbState: string): { state: DeviceState; detail?: string } {
  switch (adbState) {
    case 'device':
      return { state: 'ready' }
    case 'offline':
      return { state: 'offline' }
    case 'unauthorized':
      return { state: 'unauthorized' }
  }
  return adbState.startsWith('no permissions')
    ? { state: 'no-permissions', detail: adbState }
    : { state: 'other', detail: adbState }
}

async function readAvdName(
  adb: Adb,
  serial: string,
): Promise<string | undefined> {
  return parseEmuAvdName(
    await adb.forDevice(serial).text(['emu', 'avd', 'name']),
  )
}

async function readProps(adb: Adb, serial: string): Promise<Props> {
  return parseGetprop(await adb.forDevice(serial).text(['shell', 'getprop']))
}

async function readAvds(context: CommandContext): Promise<string[]> {
  return parseAvdList(
    await createSdkTool(context, EMULATOR).text(['-list-avds']),
  )
}

function kindOf(serial: string, props?: Props): 'emulator' | 'device' {
  return EMULATOR_SERIAL.test(serial) ||
    props?.['ro.kernel.qemu'] === '1' ||
    props?.['ro.boot.qemu'] === '1'
    ? 'emulator'
    : 'device'
}

function apiLevelOf(props: Props): number | undefined {
  const level = Number.parseInt(props['ro.build.version.sdk'] ?? '', 10)
  return Number.isNaN(level) ? undefined : level
}

function isBooted(props: Props): boolean {
  return props['sys.boot_completed'] === '1'
}

async function describeEntry(
  adb: Adb,
  entry: AdbDeviceEntry,
): Promise<{ device: Device; warnings: string[] }> {
  const { serial } = entry
  const { state, detail } = stateOf(entry.adbState)
  const [avd, props] = await Promise.all([
    EMULATOR_SERIAL.test(serial)
      ? attempt(readAvdName(adb, serial))
      : undefined,
    state === 'ready' ? attempt(readProps(adb, serial)) : undefined,
  ])

  const warnings: string[] = []
  if (avd && 'error' in avd) {
    warnings.push(`loupe can't read the AVD name of ${serial}. ${avd.error}`)
  }
  if (props && 'error' in props) {
    warnings.push(
      `loupe can't read the properties of ${serial}. ${props.error}`,
    )
  }

  const propValues = valueOf(props)
  return {
    device: {
      platform: 'android',
      kind: kindOf(serial, propValues),
      serial,
      avd: valueOf(avd),
      model: propValues?.['ro.product.model'] ?? entry.fields.model,
      state: propValues && !isBooted(propValues) ? 'booting' : state,
      detail,
      apiLevel: propValues && apiLevelOf(propValues),
    },
    warnings,
  }
}

/**
 * Lists what adb sees, then the AVDs that don't run. Without the emulator
 * tool, the list has no stopped AVDs and a warning says why.
 */
export async function listAndroidDevices(
  context: CommandContext,
): Promise<DeviceList> {
  const adb = createAdb(context)
  const entries = parseAdbDevices(await adb.text(['devices', '-l']))

  const [described, avds] = await Promise.all([
    Promise.all(entries.map((entry) => describeEntry(adb, entry))),
    attempt(readAvds(context)),
  ])

  const running = new Set(described.map(({ device }) => device.avd))
  const stopped = (valueOf(avds) ?? [])
    .filter((avd) => !running.has(avd))
    .map((avd): Device => ({
      platform: 'android',
      kind: 'emulator',
      avd,
      state: 'stopped',
    }))

  const warnings = described.flatMap((item) => item.warnings)
  if ('error' in avds) {
    warnings.push(`The list has no stopped AVDs. ${avds.error}`)
  }

  return {
    devices: [...described.map(({ device }) => device), ...stopped],
    warnings,
  }
}

function label(entry: AdbDeviceEntry): string {
  const { model } = entry.fields
  return model ? `${entry.serial} (${model})` : entry.serial
}

function unavailable(
  serial: string,
  state: DeviceState,
  detail?: string,
): LoupeError {
  let message: string
  switch (state) {
    case 'booting':
      message = `${serial} is still booting. Wait until it's ready, then try again.`
      break
    case 'offline':
      message = `${serial} is offline. Wait until adb connects to it, then try again.`
      break
    case 'unauthorized':
      message = `${serial} doesn't allow USB debugging from this computer yet. Accept the prompt on the device, then try again.`
      break
    case 'no-permissions':
      message = `loupe can't use ${serial}. adb reports: ${detail}`
      break
    default:
      message = `${serial} isn't ready. adb reports: ${detail}`
  }
  return new LoupeError('device_unavailable', message)
}

async function findEntry(
  context: CommandContext,
  adb: Adb,
  entries: readonly AdbDeviceEntry[],
  wanted: string,
): Promise<AdbDeviceEntry> {
  const bySerial = entries.find((entry) => entry.serial === wanted)
  if (bySerial) return bySerial

  const emulators = entries.filter((entry) =>
    EMULATOR_SERIAL.test(entry.serial),
  )
  const names = await Promise.all(
    emulators.map((entry) => attempt(readAvdName(adb, entry.serial))),
  )
  const byAvd = emulators.find((_, index) => valueOf(names[index]) === wanted)
  if (byAvd) return byAvd

  if (valueOf(await attempt(readAvds(context)))?.includes(wanted)) {
    throw new LoupeError(
      'device_unavailable',
      `The AVD ${wanted} doesn't run. Start it, then try again.`,
    )
  }
  throw new LoupeError(
    'no_device',
    `No device has the serial or the AVD name "${wanted}". Run "loupe devices" to see the list.`,
  )
}

function onlyReadyEntry(entries: readonly AdbDeviceEntry[]): AdbDeviceEntry {
  const ready = entries.filter((entry) => entry.adbState === 'device')
  const [first] = ready.length > 0 ? ready : entries

  if (ready.length > 1) {
    throw new LoupeError(
      'device_ambiguous',
      `${ready.length} devices are ready: ${ready.map(label).join(', ')}. Choose one with the "device" option.`,
    )
  }
  if (!first) {
    throw new LoupeError(
      'no_device',
      'loupe finds no Android device and no running emulator. Start an emulator or connect a device, then try again.',
    )
  }
  if (ready.length === 0 && entries.length > 1) {
    const states = entries.map(
      (entry) => `${entry.serial} (${stateOf(entry.adbState).state})`,
    )
    throw new LoupeError(
      'device_unavailable',
      `No device is ready: ${states.join(', ')}. Run "loupe devices" for details.`,
    )
  }
  return first
}

/**
 * Finds the device for a command: the one that `wanted` names (a serial or
 * an AVD name), else the one in ANDROID_SERIAL, else the only ready device.
 * It fails unless the device is ready, booted, and on API level 30 or later.
 */
export async function selectAndroidDevice(
  context: CommandContext,
  wanted?: string,
): Promise<AndroidTarget> {
  const adb = createAdb(context)
  const entries = parseAdbDevices(await adb.text(['devices', '-l']))
  const name = wanted ?? (context.env.ANDROID_SERIAL || undefined)
  const entry = name
    ? await findEntry(context, adb, entries, name)
    : onlyReadyEntry(entries)

  const { state, detail } = stateOf(entry.adbState)
  if (state !== 'ready') throw unavailable(entry.serial, state, detail)

  const props = await readProps(adb, entry.serial)
  if (!isBooted(props)) throw unavailable(entry.serial, 'booting')

  const apiLevel = apiLevelOf(props)
  if (apiLevel === undefined) {
    throw new LoupeError(
      'tool_failed',
      `loupe can't read the API level of ${entry.serial}.`,
    )
  }
  if (apiLevel < MIN_API_LEVEL) {
    throw new LoupeError(
      'unsupported',
      `${entry.serial} runs API level ${apiLevel}. loupe needs Android 11 (API level ${MIN_API_LEVEL}) or later.`,
    )
  }

  return {
    serial: entry.serial,
    kind: kindOf(entry.serial, props),
    apiLevel,
    adb: adb.forDevice(entry.serial),
    signal: context.signal,
  }
}
