import { type Size } from '../../core/units'
import { parseXml, type XmlElement } from './xml'

export interface AdbDeviceEntry {
  serial: string
  /** The state in the words of adb, for example `device` or `unauthorized`. */
  adbState: string
  /** The `key:value` fields of `adb devices -l`, for example `model`. */
  fields: Record<string, string>
}

/** One display, as `dumpsys window displays` gives it. Sizes are in px. */
export interface WindowDisplay {
  /** The natural orientation, with a size override if there is one. */
  natural: Size
  /** In dpi, with a density override if there is one. */
  density: number
  /** The current orientation. */
  current: Size
  /** Quarter turns from the natural orientation (`Surface.ROTATION_*`). */
  rotation: number
  /** What the app in front asks for, for example `SCREEN_ORIENTATION_PORTRAIT`. */
  appOrientation?: string
  /**
   * The title of the window that has the focus, for example
   * `com.example.app/com.example.app.MainActivity`. None when no window has
   * it, for example when the screen is off.
   */
  focus?: string
}

const FIELD = /^([a-z_]+):(\S*)$/
const PROP = /^\[([^\]]+)\]: \[(.*)\]$/
const AVD_NAME = /^[A-Za-z0-9._-]+$/

function lines(text: string): string[] {
  return text.split(/\r?\n/).map((line) => line.trim())
}

/**
 * Reads `adb devices` and `adb devices -l`. A state can have spaces ("no
 * permissions (…); see […]"), so the fields come off the end of the line
 * first, and the words that stay after the serial are the state.
 */
export function parseAdbDevices(text: string): AdbDeviceEntry[] {
  const entries: AdbDeviceEntry[] = []

  for (const line of lines(text)) {
    if (!line || line.startsWith('List of devices') || line.startsWith('*')) {
      continue
    }
    const [serial, ...rest] = line.split(/\s+/)
    if (!serial || rest.length === 0) continue

    const fields: Record<string, string> = {}
    while (rest.length > 1) {
      const match = FIELD.exec(rest.at(-1) ?? '')
      if (!match) break
      const [, key = '', value = ''] = match
      fields[key] = value
      rest.pop()
    }
    entries.push({ serial, adbState: rest.join(' '), fields })
  }

  return entries
}

/**
 * Reads `adb shell getprop`. A value that spans more lines is skipped: no
 * property that loupe reads has one.
 */
export function parseGetprop(text: string): Record<string, string> {
  const props: Record<string, string> = {}
  for (const line of lines(text)) {
    const match = PROP.exec(line)
    if (match) {
      const [, key = '', value = ''] = match
      props[key] = value
    }
  }
  return props
}

/**
 * Reads `emulator -list-avds`. Some versions of the emulator write log lines
 * ("INFO | …") before the names, so only the lines that are AVD names stay.
 */
export function parseAvdList(text: string): string[] {
  return lines(text).filter((line) => AVD_NAME.test(line))
}

const DISPLAY_HEADER = /^\s*Display: mDisplayId=(\d+)/gm

/** The part of the dump about one display, up to the next display. */
function displayBlock(text: string, displayId: number): string | undefined {
  const headers = [...text.matchAll(DISPLAY_HEADER)]
  if (headers.length === 0) return text
  const index = headers.findIndex((match) => Number(match[1]) === displayId)
  if (index === -1) return undefined
  return text.slice(headers[index]?.index, headers[index + 1]?.index)
}

/**
 * Reads one display from `dumpsys window displays`. The line with `init=`
 * holds the natural size and density, `base=` when an override is set, and
 * `cur=`, the size in the current rotation. `mRotation=` is the rotation of
 * the screen now. The user rotation setting can differ from it.
 * `mCurrentFocus=` names the window that has the focus on this display.
 */
export function parseWindowDisplays(
  text: string,
  displayId = 0,
): WindowDisplay | undefined {
  const block = displayBlock(text, displayId)
  const sizeLine = block?.split(/\r?\n/).find((line) => /^\s*init=/.test(line))
  if (!block || !sizeLine) return undefined

  const natural =
    /\bbase=(\d+)x(\d+) (\d+)dpi/.exec(sizeLine) ??
    /\binit=(\d+)x(\d+) (\d+)dpi/.exec(sizeLine)
  const current = /\bcur=(\d+)x(\d+)/.exec(sizeLine)
  const rotation = /\bmRotation=(\d)\b/.exec(block)
  if (!natural || !current || !rotation) return undefined

  return {
    natural: { width: Number(natural[1]), height: Number(natural[2]) },
    density: Number(natural[3]),
    current: { width: Number(current[1]), height: Number(current[2]) },
    rotation: Number(rotation[1]),
    appOrientation: /\bmCurrentAppOrientation=([A-Z_]+)/.exec(block)?.[1],
    focus: /^\s*mCurrentFocus=Window\{\S+ u\d+ (.+)\}\s*$/m.exec(block)?.[1],
  }
}

export interface UiautomatorDump {
  /** Quarter turns, as `mRotation` counts them. */
  rotation?: number
  /** The `node` elements at the top of the tree. */
  nodes: XmlElement[]
}

/**
 * Reads `uiautomator dump /dev/tty`: the XML, then the line "UI hierchary
 * dumped to: /dev/tty". Undefined when the output has no tree, for example
 * "ERROR: could not get idle state.". It throws an error when the XML is
 * broken.
 */
export function parseUiautomatorDump(
  text: string,
): UiautomatorDump | undefined {
  const start = text.indexOf('<hierarchy')
  if (start === -1) return undefined

  const hierarchy = parseXml(text.slice(start))
  const rotation = Number.parseInt(hierarchy.attributes.rotation ?? '', 10)
  return {
    rotation: Number.isNaN(rotation) ? undefined : rotation,
    nodes: hierarchy.children.filter((child) => child.name === 'node'),
  }
}

export interface AmStart {
  /** `ok` when the activity started. */
  status?: string
  /** `package/activity` */
  activity?: string
  /** `COLD`, `WARM` or `HOT`. */
  launchState?: string
  /** Milliseconds. */
  totalTime?: number
  /** The text after "Error: ". */
  error?: string
  /** No activity takes the intent. */
  unresolved: boolean
}

/**
 * Reads `am start -W`. Its exit code for an intent that no activity takes
 * is 0 up to API 34 and 1 from API 35, so only the text counts.
 */
export function parseAmStart(text: string): AmStart {
  const field = (name: string): string | undefined =>
    new RegExp(`^${name}: (.+?)\\s*$`, 'm').exec(text)?.[1]
  const totalTime = Number.parseInt(field('TotalTime') ?? '', 10)
  return {
    status: field('Status'),
    activity: field('Activity'),
    launchState: field('LaunchState'),
    totalTime: Number.isNaN(totalTime) ? undefined : totalTime,
    error: field('Error'),
    unresolved: text.includes('unable to resolve Intent'),
  }
}

/** Reads `adb emu avd name`: the name, then "OK". */
export function parseEmuAvdName(text: string): string | undefined {
  const [first = ''] = lines(text)
  return first !== 'OK' && AVD_NAME.test(first) ? first : undefined
}
