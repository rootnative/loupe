// Runs the built loupe CLI on one booted emulator with a clean system image,
// and checks each result. The "Android smoke" job of the CI workflow runs it
// after the build, on the lowest and the newest API level. It reads the JSON
// on a pipe, as an agent does.
//
// At the end it opens the probe app (apps/probe-app) in Expo Go, and checks
// that the safe area of the probe is the system's in portrait and in both
// landscapes. For that it downloads Expo Go from Expo, and starts Metro on
// localhost.
//
// Run it on an emulator only, with the pixel_6 profile of the workflow, after
// `pnpm install` and the build. Don't run it on a phone: it turns the screen,
// touches Settings and the home screen, and installs Expo Go.
//
// Usage: node scripts/android-smoke.mjs <out-dir> <api-level>
// It writes the JSON of each command, the screenshots and the Metro log to
// <out-dir>.

import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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

const [out, level] = process.argv.slice(2)
if (!out || !level) {
  console.error('Usage: node scripts/android-smoke.mjs <out-dir> <api-level>')
  process.exit(2)
}
const apiLevel = Number(level)
mkdirSync(out, { recursive: true })

const BIN = path.resolve('packages/loupe/dist/bin.js')
const ADB = process.env.ANDROID_HOME
  ? path.join(process.env.ANDROID_HOME, 'platform-tools', 'adb')
  : 'adb'
const SETTINGS = 'com.android.settings'
const EDGES = ['top', 'right', 'bottom', 'left']

let failures = 0
let runs = 0

function adb(...args) {
  const result = spawnSync(ADB, args, { encoding: 'utf8', timeout: 60_000 })
  if (result.status !== 0) {
    throw new Error(
      `adb ${args.join(' ')} exited with ${result.status}: ${result.stderr}`,
    )
  }
  return result.stdout
}

/** The window in front, from `mCurrentFocus`. */
function focus() {
  const dump = adb('shell', 'dumpsys', 'window', 'displays')
  return /mCurrentFocus=Window\{\S+ \S+ ([^}]+)\}/.exec(dump)?.[1] ?? ''
}

/**
 * Waits up to 15 s for a window whose title has `part`, and gives the last
 * title and the wait. On a busy emulator a new page can take a few seconds,
 * and no window has the focus in that time.
 */
async function waitForFocus(part) {
  const start = Date.now()
  let seen = focus()
  while (!seen.includes(part) && Date.now() - start < 15_000) {
    await sleep(500)
    seen = focus()
  }
  return { seen: seen || 'no window', ms: Date.now() - start }
}

/** A screenshot through adb, for a check that failed. */
function keepScreen(name) {
  const result = spawnSync(ADB, ['exec-out', 'screencap', '-p'], {
    timeout: 60_000,
  })
  if (result.status === 0) writeFileSync(path.join(out, name), result.stdout)
}

/** Runs one command, keeps its JSON, and gives the result and the exit code. */
function loupe(...args) {
  const result = spawnSync(process.execPath, [BIN, ...args, '--json'], {
    encoding: 'utf8',
    timeout: 120_000,
  })
  runs += 1
  const name = `${String(runs).padStart(2, '0')}-${args[0]}.json`
  writeFileSync(path.join(out, name), result.stdout)

  let envelope
  try {
    envelope = JSON.parse(result.stdout)
  } catch {
    envelope = {
      ok: false,
      error: { code: 'no_json', message: result.stderr.trim() },
    }
  }
  const error = envelope.ok
    ? ''
    : `, ${envelope.error.code}: ${envelope.error.message}`
  console.log(`loupe ${args.join(' ')}: exit ${result.status}${error}`)
  return { ...envelope, exit: result.status }
}

function check(passed, what) {
  console.log(`${passed ? 'pass' : 'FAIL'}: ${what}`)
  if (!passed) failures += 1
}

/** The size in the IHDR chunk, or undefined for a file that isn't a PNG. */
function pngSize(file) {
  try {
    const bytes = readFileSync(file)
    if (bytes.toString('latin1', 1, 4) !== 'PNG') return undefined
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
  } catch {
    return undefined
  }
}

function findNode(nodes, test) {
  for (const node of nodes) {
    if (test(node)) return node
    const found = findNode(node.children ?? [], test)
    if (found) return found
  }
  return undefined
}

/**
 * Waits until 3 `input` calls in a row are fast, for up to 5 minutes. Right
 * after boot the emulator is busy for a while, and the gestures through
 * `input` get slow: in CI a drag of 300 ms once took 6 s. On API 30 each
 * call starts a Java process, so fast there is under 1 s.
 */
async function settle() {
  const limit = apiLevel === 30 ? 1000 : 100
  const start = Date.now()
  let fast = 0
  while (fast < 3 && Date.now() - start < 300_000) {
    const before = performance.now()
    adb('shell', 'input', 'keyevent', '0')
    if (performance.now() - before < limit) {
      fast += 1
    } else {
      fast = 0
      await sleep(2000)
    }
  }
  const seconds = Math.round((Date.now() - start) / 1000)
  console.log(
    fast === 3
      ? `The emulator settled in ${seconds} s.`
      : `The emulator was still busy after ${seconds} s. The checks run anyway.`,
  )
}

/**
 * Reads the screen with `loupe ui` until the probe shows, for up to `limit`
 * ms. On the first open, Expo Go shows its developer menu: a sheet with a
 * "Continue" button, then the menu with a "Close" button. A busy emulator can
 * show an "isn't responding" dialog for another app. The dump of each has
 * none of the app, so loupe taps each button, as an agent does.
 */
async function waitForProbe(limit) {
  const start = Date.now()
  let screen
  do {
    screen = loupe('ui')
    if (screen.data?.probe) return { screen, ms: Date.now() - start }

    const nodes = screen.data?.nodes ?? []
    const has = (test) => findNode(nodes, test) !== undefined
    if (has((node) => node.id === 'android:id/aerr_wait')) {
      loupe('tap', '--id', 'android:id/aerr_wait')
    } else if (has((node) => node.text === 'Continue')) {
      loupe('tap', '--text', 'Continue', '--app', EXPO_GO)
    } else if (has((node) => node.text === 'Go home')) {
      loupe('tap', '--label', 'Close', '--app', EXPO_GO)
    }
    await sleep(1000)
  } while (Date.now() - start < limit)
  return { screen, ms: Date.now() - start }
}

function describeInsets(insets) {
  return insets
    ? EDGES.map(
        (edge) => `${edge} ${Math.round(insets[edge] * 100) / 100}`,
      ).join(', ')
    : 'none'
}

/**
 * The M1b gate. In portrait and in both landscapes, `insets` takes the safe
 * area from the probe, and it is the system's (the system bars and the
 * cutout) to half a pixel, with no warning. The two landscapes must mirror
 * each other, so the probe follows each side.
 */
async function checkProbeApp(metro) {
  const sdk = await installExpoGo(ADB)
  const warm = await warmMetro(metro)
  console.log(
    `Expo Go for SDK ${sdk} is in, and Metro is warm after ${warm} ms.`,
  )
  adb('reverse', `tcp:${PORT}`, `tcp:${PORT}`)

  const opened = loupe('open-url', `exp://127.0.0.1:${PORT}`, '--app', EXPO_GO)
  check(opened.ok, 'open-url: Expo Go opens the probe app')
  let found = await waitForProbe(300_000)
  if (found.screen.data?.probe) {
    // A sheet can show a moment after the app.
    await sleep(3000)
    found = await waitForProbe(60_000)
  }
  const probe = found.screen.data?.probe
  check(
    probe?.route === '/' &&
      !findNode(found.screen.data.nodes, (node) =>
        node.label?.startsWith('loupe:'),
      ),
    `ui: the report of the probe, after ${found.ms} ms, with no probe node in the tree`,
  )
  if (!probe) {
    keepScreen('probe-timeout.png')
    return
  }

  const safeAreas = {}
  for (const orientation of ['portrait', 'landscape-left', 'landscape-right']) {
    const turned = loupe('rotate', orientation)
    const reading = loupe('insets', '--app', EXPO_GO).data
    const agrees =
      reading !== undefined &&
      EDGES.every(
        (edge) =>
          Math.abs(
            reading.safeArea[edge] -
              Math.max(reading.systemBars[edge], reading.cutout[edge]),
          ) <=
          0.5 / reading.scale,
      )
    const passed =
      turned.ok &&
      reading?.orientation === orientation &&
      reading.source === 'probe' &&
      reading.warnings.length === 0 &&
      agrees
    check(
      passed,
      `insets in ${orientation}: the safe area of the probe is the system's (${describeInsets(reading?.safeArea)} dp)`,
    )
    if (!passed) keepScreen(`insets-${orientation}.png`)
    safeAreas[orientation] = reading?.safeArea
  }

  const left = safeAreas['landscape-left']
  const right = safeAreas['landscape-right']
  const same = (a, b) => Math.abs(a - b) < 0.01
  check(
    left !== undefined &&
      right !== undefined &&
      same(left.left, right.right) &&
      same(left.right, right.left) &&
      same(left.top, right.top) &&
      same(left.bottom, right.bottom) &&
      !same(left.left, left.right),
    'insets: the two landscapes mirror each other, and their sides differ',
  )
  loupe('rotate', 'portrait')
}

adb('wait-for-device')
await settle()
adb('shell', 'am', 'start', '-W', '-a', 'android.settings.SETTINGS')
await sleep(2000)

const devices = loupe('devices')
const emulator = devices.data?.devices.find(
  (device) => device.serial === 'emulator-5554',
)
check(
  emulator?.kind === 'emulator' &&
    emulator.state === 'ready' &&
    emulator.apiLevel === apiLevel,
  `devices: emulator-5554 is ready, with API level ${apiLevel}`,
)

// Settings in landscape.
const turned = loupe('rotate', 'landscape-left')
const landscape = turned.data?.pixels
check(
  turned.data?.orientation === 'landscape-left' &&
    landscape.width > landscape.height,
  'rotate: the screen is landscape-left',
)

const shot = loupe(
  'screenshot',
  path.join(out, 'landscape.png'),
  '--app',
  SETTINGS,
)
const shotSize = pngSize(shot.data?.file ?? '')
check(
  shotSize?.width === landscape?.width &&
    shotSize?.height === landscape?.height,
  'screenshot: an upright PNG of the landscape screen',
)

const ui = loupe('ui', '--app', SETTINGS)
const row = findNode(
  ui.data?.nodes ?? [],
  (node) => node.text === 'Network & internet',
)
check(
  ui.data?.orientation === 'landscape-left' && row !== undefined,
  'ui: the tree has "Network & internet"',
)

// The pixel_6 profile: API 30 has the 3-button navigation bar on the right
// in landscape-left, and later images have a cutout, on the left there.
const insets = loupe('insets')
check(
  insets.data?.orientation === 'landscape-left' &&
    (apiLevel === 30
      ? insets.data.systemBars.right > 0
      : insets.data.cutout.left > 0),
  apiLevel === 30
    ? 'insets: the navigation bar on the right'
    : 'insets: the cutout on the left',
)

const tap = loupe('tap', '--text', 'Network & internet', '--app', SETTINGS)
const opened = await waitForFocus('SubSettings')
check(
  tap.ok && opened.seen.includes('SubSettings'),
  `tap --text: the network page opens (${opened.seen}, after ${opened.ms} ms)`,
)
if (!opened.seen.includes('SubSettings')) keepScreen('after-tap.png')

const back = loupe('key', 'back', '--app', SETTINGS)
const closed = await waitForFocus('SettingsHomepageActivity')
check(
  back.ok && closed.seen.includes('SettingsHomepageActivity'),
  `key back: Settings is on its home page again (${closed.seen}, after ${closed.ms} ms)`,
)
if (!closed.seen.includes('SettingsHomepageActivity')) {
  keepScreen('after-back.png')
}

const upright = loupe('rotate', 'portrait')
check(
  upright.data?.orientation === 'portrait',
  'rotate: the screen is portrait',
)

// "System" is below the fold of the Settings list. The drags must not fling
// past it, and the last one must bring it whole into the list.
const down = loupe('scroll-to', '--text', 'System', '--app', SETTINGS)
const list = down.data?.scrollView?.frame
const found = down.data?.element.frame
check(
  down.ok &&
    down.data.scrolls >= 1 &&
    list !== undefined &&
    found.y > list.y &&
    found.y + found.height < list.y + list.height,
  `scroll-to: "System" is whole in the list after ${down.data?.scrolls} drags down`,
)
if (!down.ok) keepScreen('scroll-to-down.png')

const up = loupe(
  'scroll-to',
  '--text',
  'Network & internet',
  '--direction',
  'up',
  '--app',
  SETTINGS,
)
check(
  up.ok && up.data.scrolls >= 1,
  `scroll-to --direction up: "Network & internet" is in view after ${up.data?.scrolls} drags up`,
)
if (!up.ok) keepScreen('scroll-to-up.png')

const nothing = loupe('open-url', 'loupe-smoke://nothing')
check(
  nothing.error?.code === 'no_handler' && nothing.exit === 1,
  'open-url: no_handler for a link that no app takes',
)

const web = loupe('open-url', 'https://example.com')
check(
  web.ok && typeof web.data.activity === 'string',
  'open-url: a web link opens',
)

// The gestures, on the empty middle of the home screen. On an emulator they
// go through its console.
const home = loupe('key', 'home')
await sleep(2000)
check(home.ok, 'key home')

const size = upright.data?.size ?? { width: 0, height: 0 }
const x = Math.round(size.width / 2)
const y = Math.round(size.height / 2)

const doubleTap = loupe('double-tap', String(x), String(y))
check(
  doubleTap.data?.gap >= 40 && doubleTap.data.gap <= 300,
  `double-tap: ${doubleTap.data?.gap} ms between the taps`,
)

const dragFile = path.join(out, 'drag.png')
const drag = loupe(
  'drag',
  String(x + 100),
  String(y),
  String(x - 100),
  String(y),
  '--shot',
  dragFile,
  '--shot-at',
  '0.5',
)
check(
  drag.data?.moveTime >= 300 &&
    pngSize(dragFile)?.width === upright.data?.pixels.width,
  `drag: a screenshot during the move, which took ${drag.data?.moveTime} ms`,
)

const pinch = loupe('pinch', String(x), String(y), '--scale', '2')
check(
  pinch.data?.span.to === 400 && pinch.data.moveTime >= 300,
  `pinch: 200 → 400 dp in ${pinch.data?.moveTime} ms`,
)

// The probe app in Expo Go, after the other checks: Metro takes the CPU of
// the runner for a while, and the gesture timings above need it.
const metro = startMetro(path.join(out, 'metro.log'))
try {
  await checkProbeApp(metro)
} catch (error) {
  check(false, `probe app: ${error instanceof Error ? error.message : error}`)
  keepScreen('probe-app-error.png')
} finally {
  await stopMetro(metro)
}

console.log(
  failures === 0
    ? `All checks passed on API level ${apiLevel}.`
    : `${failures} checks failed on API level ${apiLevel}.`,
)
process.exit(failures === 0 ? 0 : 1)
