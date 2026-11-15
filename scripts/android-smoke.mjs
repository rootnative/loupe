// Runs the built loupe CLI on one booted emulator with a clean system image,
// and checks each result. The "Android smoke" job of the CI workflow runs it
// after the build, on the lowest and the newest API level. It reads the JSON
// on a pipe, as an agent does.
//
// Run it on an emulator only, with the pixel_6 profile of the workflow. Don't
// run it on a phone: it turns the screen, and touches Settings and the home
// screen.
//
// Usage: node scripts/android-smoke.mjs <out-dir> <api-level>
// It writes the JSON of each command and the screenshots to <out-dir>.

import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

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

adb('wait-for-device')
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
await sleep(2000)
check(
  tap.ok && focus().includes('SubSettings'),
  'tap --text: the network page opens',
)

const back = loupe('key', 'back', '--app', SETTINGS)
await sleep(2000)
check(
  back.ok && focus().includes('SettingsHomepageActivity'),
  'key back: Settings is on its home page again',
)

const upright = loupe('rotate', 'portrait')
check(
  upright.data?.orientation === 'portrait',
  'rotate: the screen is portrait',
)

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

// The gestures, on the empty middle of the home screen. On API 30 they go
// through the emulator console; on 36, double-tap and drag use `input`.
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

console.log(
  failures === 0
    ? `All checks passed on API level ${apiLevel}.`
    : `${failures} checks failed on API level ${apiLevel}.`,
)
process.exit(failures === 0 ? 0 : 1)
