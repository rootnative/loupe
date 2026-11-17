// Records the layout patterns of the probe app (apps/probe-app/patterns.tsx)
// for the rules of `loupe check`: each pattern as a defect and as its fixed
// twin, in portrait and in both landscapes, with the hole cutout, in LTR and
// in RTL. For each screen it keeps the raw uiautomator dump in which the
// probe shows that screen, and a screenshot; for each rotation, the display
// dump. A screen that never shows leaves its last dump, a screenshot and a
// logcat tail. The "Check fixtures" workflow runs it in CI.
//
// Run it from the root of the repository, after `pnpm install` and the build,
// on one booted emulator with a clean system image. Don't run it on a phone.
// It downloads Expo Go, installs it, starts Metro, and changes the rotation
// and the cutout overlay of the emulator.
//
// Usage: node scripts/record-check-fixtures.mjs <out-dir>
// With more than one device, set ANDROID_SERIAL to the emulator first.

import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import {
  EXPO_GO,
  installExpoGo,
  PORT,
  startMetro,
  stopMetro,
  warmMetro,
} from './lib/expo-go.mjs'

const [out] = process.argv.slice(2)
if (!out) {
  console.error('Usage: node scripts/record-check-fixtures.mjs <out-dir>')
  process.exit(2)
}
mkdirSync(out, { recursive: true })

const BIN = path.resolve('packages/loupe/dist/bin.js')
const ADB = process.env.ANDROID_HOME
  ? path.join(process.env.ANDROID_HOME, 'platform-tools', 'adb')
  : 'adb'

// The same lists as apps/probe-app/patterns.tsx.
const PATTERNS = [
  'inset',
  'sheet',
  'sides',
  'overflow',
  'target',
  'centred',
  'mirrored',
]
const ROUTES = PATTERNS.flatMap((pattern) =>
  ['defect', 'fixed'].map((variant) => `/${pattern}/${variant}`),
)
const ROTATIONS = [
  [0, 'portrait'],
  [1, 'landscape-left'],
  [3, 'landscape-right'],
]
const CUTOUT = 'com.android.internal.display.cutout.emulation.hole'

let failures = 0

function fail(what) {
  failures += 1
  console.error(`FAIL: ${what}`)
}

// A screenshot of a busy screen passes 1 MB, the default of spawnSync.
const MAX_BUFFER = 64 * 1024 * 1024

/**
 * Saves the output of one adb command, as the shell recorders do: stdout in
 * `file`, stderr in `<file>.stderr` and a non-zero exit code in
 * `<file>.exit`.
 */
function capture(file, args) {
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

/** Runs one loupe command, as an agent does, and gives its JSON. */
function loupe(...args) {
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
function focus() {
  const dump =
    spawnSync(ADB, ['shell', 'dumpsys', 'window', 'displays'], {
      encoding: 'utf8',
      timeout: 60_000,
      maxBuffer: MAX_BUFFER,
    }).stdout ?? ''
  return /mCurrentFocus=Window\{\S+ \S+ ([^}]+)\}/.exec(dump)?.[1] ?? 'none'
}

/** The probe report in a uiautomator dump, in either quote form. */
function probeOf(dump) {
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
async function showRoute(route, direction, shape, limit, log) {
  const start = Date.now()
  let openedAt = start
  open(route, log)
  let dump = ''
  while (Date.now() - start < limit) {
    dump =
      spawnSync(ADB, ['exec-out', 'uiautomator', 'dump', '/dev/tty'], {
        encoding: 'utf8',
        timeout: 60_000,
        maxBuffer: MAX_BUFFER,
      }).stdout ?? ''
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
function keepTimeout(file, dump) {
  writeFileSync(`${file}.ui-tty.txt`, dump)
  capture(`${file}.png`, ['exec-out', 'screencap', '-p'])
  capture(`${file}.logcat.txt`, ['logcat', '-d', '-t', '500'])
}

/** The file name of a route: /inset/defect gives inset-defect. */
const nameOf = (route) => route.slice(1).replaceAll('/', '-')

/** Each screen of one direction: Metro serves the app in that direction. */
async function recordDirection(direction) {
  const metro = startMetro(
    path.join(out, `metro-${direction}.log`),
    direction === 'rtl' ? { PROBE_APP_RTL: '1' } : {},
  )
  try {
    const warm = await warmMetro(metro)
    console.log(`${direction}: Metro is warm after ${warm} ms.`)
    // Expo Go applies forcesRTL when it loads the app, so it starts fresh.
    spawnSync(ADB, ['shell', 'am', 'force-stop', EXPO_GO])

    const openLog = []
    const first = await showRoute(
      ROUTES[0],
      direction,
      undefined,
      300_000,
      openLog,
    )
    writeFileSync(
      path.join(out, direction, 'open.txt'),
      `${openLog.join('\n')}\n`,
    )
    if (!first.matched) {
      fail(`${direction}: the app never showed ${ROUTES[0]} in ${direction}`)
      keepTimeout(path.join(out, direction, 'open-timeout'), first.dump)
      return
    }

    for (const [rotation, orientation] of ROTATIONS) {
      const dir = path.join(out, direction, `rotation-${rotation}`)
      const shape = rotation === 0 ? 'portrait' : 'landscape'
      const log = []
      mkdirSync(dir, { recursive: true })
      // Expo Go is in front, and follows the user rotation.
      if (!loupe('rotate', orientation).ok) {
        fail(`${direction}: rotate ${orientation}`)
        continue
      }

      for (const route of ROUTES) {
        const name = nameOf(route)
        const shown = await showRoute(route, direction, shape, 60_000, log)
        if (!shown.matched) {
          fail(`${direction}/${orientation}: no probe for ${route}`)
          keepTimeout(path.join(dir, `${name}.timeout`), shown.dump)
          continue
        }
        writeFileSync(path.join(dir, `${name}.ui-tty.txt`), shown.dump)
        capture(path.join(dir, `${name}.png`), ['exec-out', 'screencap', '-p'])
        if (route === ROUTES[0]) {
          capture(path.join(dir, 'dumpsys-window-displays.txt'), [
            'shell',
            'dumpsys',
            'window',
            'displays',
          ])
          capture(path.join(dir, 'wm-size.txt'), ['shell', 'wm', 'size'])
        }
      }
      writeFileSync(path.join(dir, 'waits.txt'), `${log.join('\n')}\n`)
      console.log(`${direction}/${orientation}: done`)
    }
  } finally {
    await stopMetro(metro)
  }
}

capture(path.join(out, 'host/adb-devices-l.txt'), ['devices', '-l'])
capture(path.join(out, 'device/getprop.txt'), ['shell', 'getprop'])

try {
  const sdk = await installExpoGo(ADB)
  console.log(`Expo Go for SDK ${sdk} is in.`)
  capture(path.join(out, 'open/reverse.txt'), [
    'reverse',
    `tcp:${PORT}`,
    `tcp:${PORT}`,
  ])
  capture(path.join(out, 'cutout/overlay-enable.txt'), [
    'shell',
    'cmd',
    'overlay',
    'enable',
    CUTOUT,
  ])
  await sleep(3000)

  for (const direction of ['ltr', 'rtl']) {
    mkdirSync(path.join(out, direction), { recursive: true })
    await recordDirection(direction)
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error))
} finally {
  loupe('rotate', 'portrait')
  capture(path.join(out, 'cutout/overlay-disable.txt'), [
    'shell',
    'cmd',
    'overlay',
    'disable',
    CUTOUT,
  ])
  spawnSync(ADB, ['shell', 'am', 'force-stop', EXPO_GO])
}

console.log(
  failures === 0
    ? 'Every screen is recorded.'
    : `${failures} screens or steps failed.`,
)
process.exit(failures === 0 ? 0 : 1)
