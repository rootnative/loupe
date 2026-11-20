import { type Insets, type Rect, type Size } from '../../core/units'
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
  /**
   * The id of the window that has the focus: the hash in `Window{…}`. A
   * dialog of an app has the title of the app's window, but its own id.
   */
  focusId?: string
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
  const focus = /^\s*mCurrentFocus=Window\{(\S+) u\d+ (.+)\}\s*$/m.exec(block)

  return {
    natural: { width: Number(natural[1]), height: Number(natural[2]) },
    density: Number(natural[3]),
    current: { width: Number(current[1]), height: Number(current[2]) },
    rotation: Number(rotation[1]),
    appOrientation: /\bmCurrentAppOrientation=([A-Z_]+)/.exec(block)?.[1],
    focus: focus?.[2],
    focusId: focus?.[1],
  }
}

/** One window of `dumpsys window windows`. */
export interface WindowEntry {
  /** The hash in `Window{…}`, as `mCurrentFocus` shows it. */
  id: string
  title: string
  /** The package that owns the window. */
  package?: string
  /**
   * The window type, for example `BASE_APPLICATION` for an activity,
   * `APPLICATION` for a dialog of an app. A type with no name shows as a
   * number: the notification shade is `2040` up to API 34.
   */
  type?: string
}

/**
 * Reads `dumpsys window windows`: each window from the top, with the
 * `package=` and the `ty=` of its block. The dump has no focus line: the
 * focus comes from `dumpsys window displays`.
 */
export function parseWindowList(text: string): WindowEntry[] {
  return text
    .split(/\n(?=\s*Window #\d+ Window\{)/)
    .flatMap((block): WindowEntry[] => {
      const header = /^\s*Window #\d+ Window\{(\S+) u\d+ (.+)\}:\s*$/m.exec(
        block,
      )
      if (!header) return []
      return [
        {
          id: header[1] ?? '',
          title: header[2] ?? '',
          package: /\bpackage=(\S+)/.exec(block)?.[1],
          type: /\bty=(\w+)/.exec(block)?.[1],
        },
      ]
    })
}

export interface InsetSource {
  /** As the dump names it: `statusBars` from API 34, `ITYPE_STATUS_BAR` before. */
  type: string
  /** In px of the current orientation. */
  frame: Rect
  visible: boolean
  /** `TOP`, `BOTTOM`, `LEFT`, `RIGHT` or `NONE`. From API 35 only. */
  sideHint?: string
}

export interface WindowInsetsDump {
  sources: InsetSource[]
  /** The cutout per edge, in px of the current orientation. */
  cutout: Insets
  /** The cutout shapes, in px. Empty with no cutout. */
  cutoutRects: Rect[]
}

// A source that has been shown once, such as the keyboard, adds its
// `visibleFrame=` before `visible=`.
const INSET_SOURCE =
  /^\s+InsetsSource (?:id=\S+ )?type=(\S+) frame=\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\](?: visibleFrame=\S+)? visible=(true|false)(?:.*\bsideHint=([A-Z]+))?/
// API 30 wraps it: mDisplayCutout=WmDisplayCutout{DisplayCutout{insets=…
const CUTOUT_INSETS =
  /mDisplayCutout=\S*?DisplayCutout\{insets=Rect\((-?\d+), (-?\d+) - (-?\d+), (-?\d+)\)/
const CUTOUT_BOUNDS = /mDisplayCutout=.*?boundingRect=\{Bounds=\[([^\]]*)\]/
const RECT = /Rect\((-?\d+), (-?\d+) - (-?\d+), (-?\d+)\)/g

function rectFromEdges(
  left: number,
  top: number,
  right: number,
  bottom: number,
): Rect {
  return { x: left, y: top, width: right - left, height: bottom - top }
}

/**
 * Reads the insets of one display from `dumpsys window displays`: the
 * `InsetsSource` lines right after `WindowInsetsStateController`, and the
 * first `mDisplayCutout`. Both are in the current orientation. A source can
 * have an empty or upside-down frame, for example a cutout side that isn't
 * there on API 30: `[0,0][2400,-2147483648]`.
 */
export function parseWindowInsets(
  text: string,
  displayId = 0,
): WindowInsetsDump | undefined {
  const block = displayBlock(text, displayId)
  if (!block) return undefined

  const sources: InsetSource[] = []
  const start = block.indexOf('WindowInsetsStateController')
  const lines = start === -1 ? [] : block.slice(start).split(/\r?\n/)
  for (const line of lines.slice(1)) {
    const match = INSET_SOURCE.exec(line)
    if (!match) {
      if (sources.length > 0) break
      continue
    }
    const [, type = '', left, top, right, bottom, visible, sideHint] = match
    sources.push({
      type,
      frame: rectFromEdges(
        Number(left),
        Number(top),
        Number(right),
        Number(bottom),
      ),
      visible: visible === 'true',
      sideHint,
    })
  }

  const cutout = CUTOUT_INSETS.exec(block)?.slice(1).map(Number) ?? []
  const [left = 0, top = 0, right = 0, bottom = 0] = cutout
  const bounds = CUTOUT_BOUNDS.exec(block)?.[1] ?? ''
  return {
    sources,
    cutout: { top, right, bottom, left },
    cutoutRects: [...bounds.matchAll(RECT)]
      .map(([, l, t, r, b]) =>
        rectFromEdges(Number(l), Number(t), Number(r), Number(b)),
      )
      .filter((rect) => rect.width > 0 && rect.height > 0),
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

  return hierarchyOf(parseXml(text.slice(start)))
}

function hierarchyOf(hierarchy: XmlElement): UiautomatorDump {
  const rotation = Number.parseInt(hierarchy.attributes.rotation ?? '', 10)
  return {
    rotation: Number.isNaN(rotation) ? undefined : rotation,
    nodes: hierarchy.children.filter((child) => child.name === 'node'),
  }
}

export interface UiautomatorWindow extends UiautomatorDump {
  /** As uiautomator names it, for example `TYPE_INPUT_METHOD`. */
  type: string
  /** For example `Gboard`. Empty for a system bar. */
  title: string
}

/**
 * Reads `uiautomator dump --windows /dev/tty`: each window of display 0,
 * from the top, with its tree. The plain dump has only the window in focus,
 * so it doesn't show a sheet of the keyboard. Undefined when the output has
 * no tree; it throws an error when the XML is broken.
 */
export function parseUiautomatorWindows(
  text: string,
): UiautomatorWindow[] | undefined {
  const start = text.indexOf('<displays')
  if (start === -1) return undefined

  const display = parseXml(text.slice(start)).children.find(
    (child) => child.name === 'display' && child.attributes.id === '0',
  )
  return (display?.children ?? [])
    .filter((child) => child.name === 'window')
    .map((window) => {
      const hierarchy = window.children.find(
        (child) => child.name === 'hierarchy',
      )
      return {
        type: window.attributes.type ?? '',
        title: window.attributes.title ?? '',
        ...(hierarchy ? hierarchyOf(hierarchy) : { nodes: [] }),
      }
    })
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

/**
 * Reads `cmd uimode night`, with or without a new value: `Night mode: no`.
 * Gives the mode as Android names it: `no`, `yes`, `auto` or `custom`.
 */
export function parseNightMode(text: string): string | undefined {
  return /^Night mode: (\w+)/m.exec(text)?.[1]
}

/** Reads `adb emu avd name`: the name, then "OK". */
export function parseEmuAvdName(text: string): string | undefined {
  const [first = ''] = lines(text)
  return first !== 'OK' && AVD_NAME.test(first) ? first : undefined
}

/** One task of `dumpsys activity recents`. */
export interface RecentTask {
  /** The task id: the `#` number of `Task{…}`. */
  id: number
  /** `standard` for an app, `home` for a launcher. */
  type?: string
  /** The package of the component of the task's base intent. */
  package?: string
}

/**
 * Reads `dumpsys activity recents`: the tasks from the most recent, which
 * is the one in front. Each one starts with `* Recent #N: Task{<hash> #<id>
 * … type=<type> …}`, and its `intent={… cmp=<package>/<activity> …}` line
 * follows. Where `type=` stands in the header changes between versions.
 */
export function parseRecentTasks(text: string): RecentTask[] {
  return text
    .split(/\n(?=\s*\* Recent #\d+:)/)
    .flatMap((block): RecentTask[] => {
      const header = /^\s*\* Recent #\d+: Task\{\S+ #(\d+)([^}\n]*)/.exec(block)
      if (!header) return []
      const intent = /^\s*intent=\{(.*)\}\s*$/m.exec(block)?.[1]
      return [
        {
          id: Number(header[1]),
          type: /\btype=(\w+)/.exec(header[2] ?? '')?.[1],
          package: /\bcmp=([^/\s]+)\//.exec(intent ?? '')?.[1],
        },
      ]
    })
}
