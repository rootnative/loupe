import {
  byCommand,
  type FakeCall,
  type FakeRun,
  fakeContext,
} from './fake-exec'
import { fakeFetch } from './fake-fetch'
import { recorded, recordedText } from './fixtures'
import { metroRoutes } from './metro'
import { pngHeader } from './png'

export const ADB = 'adb -s emulator-5554'
const DISPLAYS = 'sheets/alert/back/before.dumpsys-window-displays.txt'
const EXPERIENCE =
  'host.exp.exponent/host.exp.exponent.experience.ExperienceActivity'

/** Round 10's dump of one Expo Go screen, with `change` on its text. */
export function expoDump(
  level: 30 | 36,
  file: string,
  change: (text: string) => string = (text) => text,
): FakeRun {
  return { stdout: change(recordedText(`api-${level}/expo/${file}`)) }
}

/** A display dump with this window in focus. */
export function focusOn(level: 30 | 36, title: string): FakeRun {
  return {
    stdout: recordedText(`api-${level}/${DISPLAYS}`).replace(EXPERIENCE, title),
  }
}

/**
 * An emulator with Expo Go, and the probe app's Metro. Each `input` call and
 * each force-stop succeeds. Each `am start` gives `start`: a warm start by
 * default.
 */
export function expoEmulator(
  level: 30 | 36,
  dumps: readonly FakeRun[],
  runs: Readonly<Record<string, FakeRun | readonly FakeRun[]>> = {},
  start: FakeRun = recorded('api-36/extra/am-start-https.txt'),
) {
  const table = byCommand({
    'adb devices -l': recorded(`api-${level}/host/adb-devices-l.txt`),
    [`${ADB} shell getprop`]: recorded(`api-${level}/device/getprop.txt`),
    [`${ADB} shell pm path host.exp.exponent`]: recorded(
      `api-${level}/expo/expo-go/pm-path.txt`,
    ),
    [`${ADB} shell dumpsys package host.exp.exponent`]: recorded(
      `api-${level}/expo/expo-go/dumpsys-package.txt`,
    ),
    [`${ADB} reverse tcp:8081 tcp:8081`]: recorded(
      `api-${level}/expo/open/reverse.txt`,
    ),
    [`${ADB} shell dumpsys window displays`]: recorded(
      `api-${level}/${DISPLAYS}`,
    ),
    [`${ADB} exec-out uiautomator dump /dev/tty`]: dumps,
    [`${ADB} exec-out screencap -p`]: { stdout: pngHeader(1080, 2400) },
    ...runs,
  })
  const { context, calls } = fakeContext((call) => {
    if (call.args.includes('force-stop')) return {}
    if (call.args.includes('am')) return start
    if (call.args.includes('input')) return {}
    return table(call)
  })
  const { fetch, requests } = fakeFetch(metroRoutes())
  return { context: { ...context, fetch }, calls, requests }
}

export const opensOf = (calls: readonly FakeCall[]) =>
  calls.filter(
    (call) => call.args.includes('am') && call.args.includes('start'),
  )
export const tapsOf = (calls: readonly FakeCall[]) =>
  calls.filter((call) => call.args.includes('input'))
