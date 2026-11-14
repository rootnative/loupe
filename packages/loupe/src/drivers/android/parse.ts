export interface AdbDeviceEntry {
  serial: string
  /** The state in the words of adb, for example `device` or `unauthorized`. */
  adbState: string
  /** The `key:value` fields of `adb devices -l`, for example `model`. */
  fields: Record<string, string>
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

/** Reads `adb emu avd name`: the name, then "OK". */
export function parseEmuAvdName(text: string): string | undefined {
  const [first = ''] = lines(text)
  return first !== 'OK' && AVD_NAME.test(first) ? first : undefined
}
