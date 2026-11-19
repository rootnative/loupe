// Records what starts Gboard's stylus mode, and what closes it (round 9b).
// Round 9 showed that after loupe's touches through the emulator console,
// Gboard on API 35 and 36 shows a "Try out your stylus" sheet, and under it
// a handwriting toolbar in place of the keyboard: the keyboard's inset
// source is visible with little or no height, and the Back that closes the
// toolbar also reaches the app. The console touches come from a device with
// a STYLUS source.
//
// One run makes one gesture, so each gesture has its own clean emulator:
//
// - none: no gesture, to rule out the time since the boot;
// - double-tap, drag, pinch: that loupe command, on the home screen;
// - finger: a drag and a pinch through the console from this script, with
//   `ABS_MT_TOOL_TYPE` 0 (a finger) on each pointer.
//
// It taps the field of the probe app's /sheets route once before the
// gesture (fresh) and three times after it (after-1 to after-3), and records
// what shows each time: the keyboard, the stylus mode, or nothing. Then it
// tries each way in turn until the keyboard's inset source is gone. On the
// keyboard: escape (the Escape key), then back (the Back key). In stylus
// mode: escape, cancel (a tap on the sheet's Cancel button), escape again,
// then back. After each try it keeps the display dump, the input method
// state, a dump and a screenshot; the probe app counts each Back that
// reaches it. The "Stylus fixtures" workflow runs it in CI.
//
// Run it from the root of the repository, after `pnpm install` and the
// build, on one booted emulator with a clean system image. Don't run it on a
// phone: it installs Expo Go and starts Metro.
//
// Usage: node scripts/record-stylus.mjs <out-dir> <gesture>
// With more than one device, set ANDROID_SERIAL to the emulator first.

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
import {
  ADB,
  adbText,
  capture,
  dumpUi,
  keepTimeout,
  loupe,
  showRoute,
} from './lib/recorder.mjs'

const GESTURES = ['none', 'double-tap', 'drag', 'pinch', 'finger']
const [out, gesture] = process.argv.slice(2)
if (!out || !GESTURES.includes(gesture)) {
  console.error(
    `Usage: node scripts/record-stylus.mjs <out-dir> <${GESTURES.join('|')}>`,
  )
  process.exit(2)
}
mkdirSync(out, { recursive: true })

const ROUTE = '/sheets'
const SHOW_LIMIT_MS = 5000
const HIDE_LIMIT_MS = 3000
const SETTLE_MS = 1500
const KEYBOARD_WAYS = ['escape', 'back']
const STYLUS_WAYS = ['escape', 'cancel', 'escape', 'back']
// The Cancel button of the sheet, as a share of the screen (portrait), from
// the screenshots of round 9 (1080 × 2400): x 600; y 2274 on API 36 and 2210
// on API 35, where the sheet sits higher. Only for a screen whose dump of
// each window doesn't have the button.
const CANCEL_X = 600 / 1080
const CANCEL_Y = { 35: 2210 / 2400, default: 2274 / 2400 }
// The emulator's touchscreen reports 0 to 32767 on each axis.
const RAW_UNITS = 32768

let failures = 0

function fail(what) {
  failures += 1
  console.error(`FAIL: ${what}`)
}

/** The size of the screen in px, from `wm size`. */
function screenSize() {
  const size = adbText(['shell', 'wm', 'size'])
  const [, width = '0', height = '0'] =
    /(?:Override|Physical) size: (\d+)x(\d+)/.exec(size) ?? []
  return { width: Number(width), height: Number(height) }
}

/** The text of the element with this resource-id in a uiautomator dump. */
function textOf(dump, id) {
  return (
    new RegExp(`text="([^"]*)" resource-id="${id}"`).exec(dump)?.[1] ?? 'none'
  )
}

const SCREEN = screenSize()
const API_LEVEL = Number(
  adbText(['shell', 'getprop', 'ro.build.version.sdk']).trim(),
)

/**
 * What the keyboard's inset source shows: `keyboard` (visible, a fifth of
 * the screen or more), `stylus` (visible and lower: the stylus sheet or the
 * handwriting toolbar, 0 px on API 36 and 63 px on API 35), or `none`.
 */
function keyboardOf(displays) {
  const start = displays.indexOf('WindowInsetsStateController')
  const match =
    /InsetsSource (?:id=\S+ )?type=(?:ime|ITYPE_IME) frame=\[-?\d+,(-?\d+)\]\[-?\d+,(-?\d+)\](?: visibleFrame=\S+)? visible=(true|false)/.exec(
      displays.slice(Math.max(0, start)),
    )
  if (!match || match[3] !== 'true') return { kind: 'none', height: 0 }
  const height = Number(match[2]) - Number(match[1])
  return {
    kind: height * 5 >= SCREEN.height ? 'keyboard' : 'stylus',
    height,
  }
}

function describe({ kind, height }) {
  return kind === 'none' ? 'none' : `${kind} (${height} px)`
}

function readKeyboard() {
  return keyboardOf(adbText(['shell', 'dumpsys', 'window', 'displays']))
}

/** Reads the keyboard until `done` gives true, for up to `limit` ms. */
async function keyboardUntil(done, limit) {
  const start = Date.now()
  let seen = readKeyboard()
  while (!done(seen.kind) && Date.now() - start < limit) {
    await sleep(250)
    seen = readKeyboard()
  }
  return { seen, ms: Date.now() - start }
}

/** The state of the screen as `<name>.*` in `dir`; gives the dump. */
function keepState(dir, name, full = false) {
  const displays = capture(
    path.join(dir, `${name}.dumpsys-window-displays.txt`),
    ['shell', 'dumpsys', 'window', 'displays'],
  )
  capture(path.join(dir, `${name}.input-method.txt`), [
    'shell',
    'dumpsys',
    'input_method',
  ])
  if (full) {
    capture(path.join(dir, `${name}.dumpsys-window-windows.txt`), [
      'shell',
      'dumpsys',
      'window',
      'windows',
    ])
    capture(path.join(dir, `${name}.input.txt`), ['shell', 'dumpsys', 'input'])
  }
  const dump = dumpUi()
  writeFileSync(path.join(dir, `${name}.ui-tty.txt`), dump)
  capture(path.join(dir, `${name}.png`), ['exec-out', 'screencap', '-p'])
  return { dump, keyboard: keyboardOf(String(displays.stdout ?? '')) }
}

/**
 * The middle of the sheet's Cancel button: from a dump of each window when
 * it has the button (the plain dump has only the app's nodes), else from the
 * screenshots of round 9.
 */
function cancelPoint(file) {
  const windows = capture(`${file}.ui-windows.txt`, [
    'exec-out',
    'uiautomator',
    'dump',
    '--windows',
    '/dev/tty',
  ])
  const bounds =
    /text="Cancel"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(
      String(windows.stdout ?? ''),
    )
  if (bounds) {
    const [left, top, right, bottom] = bounds.slice(1).map(Number)
    return {
      point: [Math.round((left + right) / 2), Math.round((top + bottom) / 2)],
      from: 'the dump of each window',
    }
  }
  return {
    point: [
      Math.round(SCREEN.width * CANCEL_X),
      Math.round(SCREEN.height * (CANCEL_Y[API_LEVEL] ?? CANCEL_Y.default)),
    ],
    from: 'the screenshots of round 9',
  }
}

function send(way, file) {
  switch (way) {
    case 'escape':
      capture(file, ['shell', 'input', 'keyevent', 'KEYCODE_ESCAPE'])
      return
    case 'back':
      capture(file, ['shell', 'input', 'keyevent', 'KEYCODE_BACK'])
      return
    case 'cancel': {
      const { point, from } = cancelPoint(file)
      writeFileSync(`${file}.point.txt`, `${point.join(' ')} from ${from}\n`)
      capture(file, ['shell', 'input', 'tap', ...point.map(String)])
      return
    }
  }
}

/**
 * Opens /sheets, taps the field, records what shows, and tries each way to
 * close it in turn until it's gone.
 */
async function recordTap(name) {
  const dir = path.join(out, name)
  mkdirSync(dir, { recursive: true })
  const log = []
  const shown = await showRoute(ROUTE, 'ltr', undefined, 180_000, log)
  writeFileSync(path.join(dir, 'prepare.txt'), `${log.join('\n')}\n`)
  if (!shown.matched) {
    keepTimeout(path.join(dir, 'prepare'), shown.dump)
    fail(`${name}: the probe app never showed ${ROUTE}`)
    return `${name}: not run`
  }

  const before = keepState(dir, 'before')
  const tap = loupe('tap', '--id', 'field', '--app', EXPO_GO)
  writeFileSync(path.join(dir, 'tap.json'), `${JSON.stringify(tap, null, 2)}\n`)
  const opened = await keyboardUntil((kind) => kind !== 'none', SHOW_LIMIT_MS)
  await sleep(SETTLE_MS)
  const open = keepState(dir, 'open', true)
  const lines = [
    name,
    `before: ${describe(before.keyboard)}, ${textOf(before.dump, 'backs')}`,
    `open: ${describe(open.keyboard)} after ${opened.ms} ms, ${textOf(open.dump, 'keyboard')}, ${textOf(open.dump, 'backs')}`,
  ]

  const ways = open.keyboard.kind === 'stylus' ? STYLUS_WAYS : KEYBOARD_WAYS
  let state = open
  for (const [index, way] of ways.entries()) {
    if (state.keyboard.kind === 'none') break
    const file = path.join(dir, `${index + 1}-${way}.send.txt`)
    send(way, file)
    const hidden = await keyboardUntil((kind) => kind === 'none', HIDE_LIMIT_MS)
    await sleep(SETTLE_MS)
    state = keepState(dir, `${index + 1}-${way}`)
    lines.push(
      `${way}: ${describe(state.keyboard)} (${hidden.seen.kind === 'none' ? `hidden after ${hidden.ms} ms` : 'not hidden'}), ${textOf(state.dump, 'keyboard')}, ${textOf(state.dump, 'backs')}`,
    )
  }
  if (state.keyboard.kind !== 'none') fail(`${name}: the keyboard stayed open`)

  const line = lines.join('\n  ')
  console.log(line)
  return line
}

function rawUnit(pixels, size) {
  return Math.min(Math.floor((pixels * RAW_UNITS) / size), RAW_UNITS - 1)
}

/** One call of the emulator console; gives its reply. */
function consoleSend(events) {
  return adbText(['emu', 'event', 'send', ...events]).trim()
}

/**
 * Puts the fingers of the first step down, moves them through the next
 * steps, and lifts them: loupe's console events, and `ABS_MT_TOOL_TYPE` 0
 * on each pointer. Each finger is a point in px. Gives the console's replies.
 */
async function fingerGesture(steps) {
  const position = ([x, y]) => [
    `EV_ABS:ABS_MT_POSITION_X:${rawUnit(x, SCREEN.width)}`,
    `EV_ABS:ABS_MT_POSITION_Y:${rawUnit(y, SCREEN.height)}`,
  ]
  const [first, ...next] = steps
  const replies = [
    consoleSend([
      ...first.flatMap((finger, slot) => [
        `EV_ABS:ABS_MT_SLOT:${slot}`,
        `EV_ABS:ABS_MT_TRACKING_ID:${slot + 1}`,
        'EV_ABS:ABS_MT_TOOL_TYPE:0',
        ...position(finger),
        'EV_ABS:ABS_MT_PRESSURE:50',
      ]),
      'EV_KEY:BTN_TOUCH:1',
      'EV_SYN:0:0',
    ]),
  ]
  for (const fingers of next) {
    await sleep(40)
    replies.push(
      consoleSend([
        ...fingers.flatMap((finger, slot) => [
          `EV_ABS:ABS_MT_SLOT:${slot}`,
          ...position(finger),
        ]),
        'EV_SYN:0:0',
      ]),
    )
  }
  await sleep(250)
  replies.push(
    consoleSend([
      ...first.flatMap((_, slot) => [
        `EV_ABS:ABS_MT_SLOT:${slot}`,
        'EV_ABS:ABS_MT_TRACKING_ID:-1',
      ]),
      'EV_KEY:BTN_TOUCH:0',
      'EV_SYN:0:0',
    ]),
  )
  return replies
}

/** The gesture of this run on the home screen, as the smoke run makes it. */
async function makeGesture(dir) {
  mkdirSync(dir, { recursive: true })
  loupe('key', 'home')
  await sleep(2000)
  const { width, height } = SCREEN
  const density = Number(
    /(?:Override|Physical) density: (\d+)/.exec(
      adbText(['shell', 'wm', 'density']),
    )?.[1] ?? 160,
  )
  const x = Math.round(width / 2 / (density / 160))
  const y = Math.round(height / 2 / (density / 160))
  const steps = Array.from({ length: 9 }, (_, index) => index / 8)
  const results = await (async () => {
    switch (gesture) {
      case 'double-tap':
        return [loupe('double-tap', String(x), String(y))]
      case 'drag':
        return [
          loupe('drag', String(x + 100), String(y), String(x - 100), String(y)),
        ]
      case 'pinch':
        return [loupe('pinch', String(x), String(y), '--scale', '2')]
      case 'finger':
        return [
          await fingerGesture(
            steps.map((share) => [[width * (0.75 - share / 2), height / 2]]),
          ),
          await fingerGesture(
            steps.map((share) => [
              [width / 2, height * (0.4 - share / 10)],
              [width / 2, height * (0.6 + share / 10)],
            ]),
          ),
        ]
      default:
        return []
    }
  })()
  writeFileSync(
    path.join(dir, 'gestures.json'),
    `${JSON.stringify(results, null, 2)}\n`,
  )
  await sleep(2000)
  capture(path.join(dir, 'input.txt'), ['shell', 'dumpsys', 'input'])
}

capture(path.join(out, 'host/adb-devices-l.txt'), ['devices', '-l'])
capture(path.join(out, 'device/getprop.txt'), ['shell', 'getprop'])
capture(path.join(out, 'device/ime-help.txt'), ['shell', 'ime', 'help'])
capture(path.join(out, 'device/input-method-help.txt'), [
  'shell',
  'cmd',
  'input_method',
  'help',
])
capture(path.join(out, 'device/input-at-start.txt'), [
  'shell',
  'dumpsys',
  'input',
])
capture(path.join(out, 'device/stylus-handwriting-at-start.txt'), [
  'shell',
  'settings',
  'get',
  'secure',
  'stylus_handwriting_enabled',
])

let metro
const summary = [`gesture: ${gesture}`]
try {
  const sdk = await installExpoGo(ADB)
  console.log(`Expo Go for SDK ${sdk} is in.`)
  capture(path.join(out, 'open/reverse.txt'), [
    'reverse',
    `tcp:${PORT}`,
    `tcp:${PORT}`,
  ])
  metro = startMetro(path.join(out, 'metro.log'))
  const warm = await warmMetro(metro)
  console.log(`Metro is warm after ${warm} ms.`)
  capture(path.join(out, 'expo-go/force-stop.txt'), [
    'shell',
    'am',
    'force-stop',
    EXPO_GO,
  ])

  summary.push(await recordTap('fresh'))
  await makeGesture(path.join(out, 'gesture'))
  summary.push(await recordTap('after-1'))
  summary.push(await recordTap('after-2'))
  summary.push(await recordTap('after-3'))
} catch (error) {
  fail(error instanceof Error ? error.message : String(error))
} finally {
  writeFileSync(path.join(out, 'summary.txt'), `${summary.join('\n')}\n`)
  if (metro) await stopMetro(metro)
  capture(path.join(out, 'expo-go/force-stop-end.txt'), [
    'shell',
    'am',
    'force-stop',
    EXPO_GO,
  ])
}

console.log(
  failures === 0
    ? 'Each tap is recorded.'
    : `${failures} taps or steps failed.`,
)
process.exit(failures === 0 ? 0 : 1)
