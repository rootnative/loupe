// Shared by the recorders that run on an emulator in CI: adb with its raw
// output kept, the built loupe CLI, and the probe app in Expo Go. Run them
// from the root of the repository, after `pnpm install` and the build.

import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { EXPO_GO, PORT } from './expo-go.mjs'

export const BIN = path.resolve('packages/loupe/dist/bin.js')
export const ADB = process.env.ANDROID_HOME
  ? path.join(process.env.ANDROID_HOME, 'platform-tools', 'adb')
  : 'adb'

// A screenshot of a busy screen passes 1 MB, the default of spawnSync.
const MAX_BUFFER = 64 * 1024 * 1024

/**
 * Saves the output of one adb command, as the shell recorders do: stdout in
 * `file`, stderr in `<file>.stderr` and a non-zero exit code in
 * `<file>.exit`.
 */
export function capture(file, args) {
  const result = spawnSync(ADB, args, {
    timeout: 120_000,
    maxBuffer: MAX_BUFFER,
  })
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, result.stdout ?? Buffer.alloc(0))
  if (result.stderr?.length) writeFileSync(`${file}.stderr`, result.stderr)
  if (result.status !== 0) {
    writeFileSync(`${file}.exit`, `${result.status ?? result.error}\n`)
  }
  return result
}

/** Runs one adb command, and gives its stdout as text. */
export function adbText(args) {
  return (
    spawnSync(ADB, args, {
      encoding: 'utf8',
      timeout: 60_000,
      maxBuffer: MAX_BUFFER,
    }).stdout ?? ''
  )
}

/** Runs one loupe command, as an agent does, and gives its JSON. */
export function loupe(...args) {
  const result = spawnSync(process.execPath, [BIN, ...args, '--json'], {
    encoding: 'utf8',
    timeout: 120_000,
  })
  try {
    const envelope = JSON.parse(result.stdout)
    if (!envelope.ok) {
      console.log(`loupe ${args.join(' ')}: ${envelope.error.code}`)
    }
    return envelope
  } catch {
    console.log(`loupe ${args.join(' ')}: no JSON (${result.status})`)
    return { ok: false }
  }
}

/** The window in front, from `mCurrentFocus`. */
export function focus() {
  const dump = adbText(['shell', 'dumpsys', 'window', 'displays'])
  return /mCurrentFocus=Window\{\S+ \S+ ([^}]+)\}/.exec(dump)?.[1] ?? 'none'
}

/** The raw uiautomator dump of the screen. */
export function dumpUi() {
  return adbText(['exec-out', 'uiautomator', 'dump', '/dev/tty'])
}

/** The probe report in a uiautomator dump, in either quote form. */
export function probeOf(dump) {
  const match =
    /content-desc='loupe:([^']*)'|content-desc="loupe:([^"]*)"/.exec(dump)
  if (!match) return undefined
  const label = (match[1] ?? match[2])
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&')
  try {
    return JSON.parse(label)
  } catch {
    return undefined
  }
}

const shapeOf = ({ width, height }) =>
  width > height ? 'landscape' : 'portrait'

/** Opens the route in Expo Go, and logs what `open-url` gave. */
function open(route, log) {
  const opened = loupe(
    'open-url',
    `exp://127.0.0.1:${PORT}/--${route}`,
    '--app',
    EXPO_GO,
  )
  log.push(
    opened.ok
      ? `${route}: opened in ${opened.data.activity ?? 'no activity'} (${opened.data.launchState ?? '?'}, ${opened.data.totalTime ?? '?'} ms)`
      : `${route}: open-url failed: ${opened.error?.code ?? 'no JSON'}`,
  )
}

// While the screen doesn't show, the link goes again this often. On Android
// 14 and later, Expo Go can leave the front after a cold start in RTL and not
// come back; a new link brings it back.
const OPEN_AGAIN_MS = 20_000

/**
 * Opens the route, then dumps the screen until the probe shows `route` in
 * `direction`, with a window of `shape` (any shape when it's undefined), for
 * up to `limit` ms. On the way it taps through Expo Go's developer menu
 * ("Continue", then "Close") and an "isn't responding" dialog, and opens the
 * route again every 20 s. Gives the last dump and whether it matched. Each
 * step adds a line to `log`.
 */
export async function showRoute(route, direction, shape, limit, log) {
  const start = Date.now()
  let openedAt = start
  open(route, log)
  let dump = ''
  while (Date.now() - start < limit) {
    dump = dumpUi()
    const probe = probeOf(dump)
    const ms = Date.now() - start
    log.push(
      `${route}: ${ms} ms, probe ${probe ? `${probe.route} ${probe.direction} ${shapeOf(probe.window)}` : 'none'}`,
    )
    if (
      probe?.route === route &&
      probe.direction === direction &&
      (shape === undefined || shapeOf(probe.window) === shape)
    ) {
      return { dump, matched: true }
    }
    if (dump.includes('resource-id="android:id/aerr_wait"')) {
      loupe('tap', '--id', 'android:id/aerr_wait')
    } else if (dump.includes('text="Continue"')) {
      loupe('tap', '--text', 'Continue', '--app', EXPO_GO)
    } else if (dump.includes('text="Go home"')) {
      loupe('tap', '--label', 'Close', '--app', EXPO_GO)
    } else if (Date.now() - openedAt >= OPEN_AGAIN_MS) {
      log.push(`${route}: ${ms} ms, in front: ${focus()}; open again`)
      open(route, log)
      openedAt = Date.now()
    }
    await sleep(500)
  }
  return { dump, matched: false }
}

/** What a failed wait leaves: the last dump, the screen, and the log. */
export function keepTimeout(file, dump) {
  writeFileSync(`${file}.ui-tty.txt`, dump)
  capture(`${file}.png`, ['exec-out', 'screencap', '-p'])
  capture(`${file}.logcat.txt`, ['logcat', '-d', '-t', '500'])
}
