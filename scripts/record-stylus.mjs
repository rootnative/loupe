// Records Gboard's "Try out your stylus" sheet, and what each way to close it
// does. In the smoke run on API 36, a tap on the field of the probe app's
// /sheets route showed that sheet in place of the keyboard: the keyboard's
// window filled the screen, its inset source was visible with no height, and
// the Back that closed it also reached the app.
//
// One run taps the field at these points, and records what shows each time
// (the keyboard, the sheet, or nothing):
//
// - fresh: first, before any other touch;
// - after-browser: after a web link opened the browser, as the smoke run does;
// - after-gestures: after a double-tap, a drag and a pinch through the
//   emulator console on the home screen, as the smoke run does;
// - again-1, again-2: two more taps, to see if the sheet comes back;
// - stylus-off: with `stylus_handwriting_enabled` set to 0 first.
//
// While the sheet shows, it tries each way in turn until the keyboard is
// gone: escape (the Escape key), outside (a tap above the sheet), cancel (a
// tap where the sheet has its Cancel button), back (the Back key). Each new
// sheet starts one way further on. The keyboard closes with Back. After each
// try it keeps the display dump, the input method state, a dump and a
// screenshot; the probe app counts each Back that reaches it. The "Stylus
// fixtures" workflow runs it in CI.
//
// Run it from the root of the repository, after `pnpm install` and the
// build, on one booted emulator with a clean system image. Don't run it on a
// phone: it installs Expo Go, starts Metro, opens the browser, and changes a
// secure setting.
//
// Usage: node scripts/record-stylus.mjs <out-dir>
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

const [out] = process.argv.slice(2)
if (!out) {
  console.error('Usage: node scripts/record-stylus.mjs <out-dir>')
  process.exit(2)
}
mkdirSync(out, { recursive: true })

const ROUTE = '/sheets'
const SHOW_LIMIT_MS = 5000
const HIDE_LIMIT_MS = 3000
const SETTLE_MS = 1500
const WAYS = ['escape', 'outside', 'cancel', 'back']
// The Cancel button of the sheet, as a share of the screen (portrait), from
// the smoke run's screenshot on API 36: x 600, y 2274 of 1080 × 2400.
const CANCEL = { x: 600 / 1080, y: 2274 / 2400 }

let failures = 0
let nextWay = 0

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

/**
 * What the keyboard's inset source shows: `keyboard` (visible, with a
 * height), `sheet` (visible, with no height: the stylus sheet), or `none`.
 */
function keyboardOf(displays) {
  const start = displays.indexOf('WindowInsetsStateController')
  const match =
    /InsetsSource (?:id=\S+ )?type=(?:ime|ITYPE_IME) frame=\[-?\d+,(-?\d+)\]\[-?\d+,(-?\d+)\](?: visibleFrame=\S+)? visible=(true|false)/.exec(
      displays.slice(Math.max(0, start)),
    )
  if (!match || match[3] !== 'true') return 'none'
  return Number(match[2]) > Number(match[1]) ? 'keyboard' : 'sheet'
}

function readKeyboard() {
  return keyboardOf(adbText(['shell', 'dumpsys', 'window', 'displays']))
}

/** Reads the keyboard until `done` gives true, for up to `limit` ms. */
async function keyboardUntil(done, limit) {
  const start = Date.now()
  let seen = readKeyboard()
  while (!done(seen) && Date.now() - start < limit) {
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

function send(way, file) {
  switch (way) {
    case 'escape':
      capture(file, ['shell', 'input', 'keyevent', 'KEYCODE_ESCAPE'])
      return
    case 'back':
      capture(file, ['shell', 'input', 'keyevent', 'KEYCODE_BACK'])
      return
    case 'outside':
    case 'cancel': {
      const { width, height } = screenSize()
      const point =
        way === 'outside'
          ? [Math.round(width / 2), Math.round(height * 0.2)]
          : [Math.round(width * CANCEL.x), Math.round(height * CANCEL.y)]
      writeFileSync(`${file}.point.txt`, `${point.join(' ')}\n`)
      capture(file, ['shell', 'input', 'tap', ...point.map(String)])
      return
    }
  }
}

/** The ways to try on this sheet, from the next one in turn. */
function waysForSheet() {
  const start = nextWay % WAYS.length
  nextWay += 1
  const order = [...WAYS.slice(start), ...WAYS.slice(0, start)]
  // Back last: it is known to close the sheet.
  return [...order.filter((way) => way !== 'back'), 'back']
}

/**
 * Opens /sheets, taps the field, records what shows, and closes it: the
 * keyboard with Back, the sheet with each way in turn until it's gone.
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
  const opened = await keyboardUntil((seen) => seen !== 'none', SHOW_LIMIT_MS)
  await sleep(SETTLE_MS)
  const open = keepState(dir, 'open', true)
  const lines = [
    name,
    `before: ${before.keyboard}, ${textOf(before.dump, 'backs')}`,
    `open: ${open.keyboard} after ${opened.ms} ms, ${textOf(open.dump, 'keyboard')}, ${textOf(open.dump, 'backs')}`,
  ]

  const ways = open.keyboard === 'sheet' ? waysForSheet() : ['back']
  let state = open
  for (const [index, way] of ways.entries()) {
    if (state.keyboard === 'none') break
    const file = path.join(dir, `${index + 1}-${way}.send.txt`)
    send(way, file)
    const hidden = await keyboardUntil((seen) => seen === 'none', HIDE_LIMIT_MS)
    await sleep(SETTLE_MS)
    state = keepState(dir, `${index + 1}-${way}`)
    lines.push(
      `${way}: ${state.keyboard} (${hidden.seen === 'none' ? `hidden after ${hidden.ms} ms` : 'not hidden'}), ${textOf(state.dump, 'keyboard')}, ${textOf(state.dump, 'backs')}`,
    )
  }
  if (state.keyboard !== 'none') fail(`${name}: the keyboard stayed open`)

  const line = lines.join('\n  ')
  console.log(line)
  return line
}

/** The double-tap, drag and pinch of the smoke run, on the home screen. */
async function consoleGestures(dir) {
  mkdirSync(dir, { recursive: true })
  loupe('key', 'home')
  await sleep(2000)
  const { width, height } = screenSize()
  const density = Number(
    /(?:Override|Physical) density: (\d+)/.exec(
      adbText(['shell', 'wm', 'density']),
    )?.[1] ?? 160,
  )
  const x = Math.round(width / 2 / (density / 160))
  const y = Math.round(height / 2 / (density / 160))
  const results = [
    loupe('double-tap', String(x), String(y)),
    loupe('drag', String(x + 100), String(y), String(x - 100), String(y)),
    loupe('pinch', String(x), String(y), '--scale', '2'),
  ]
  writeFileSync(
    path.join(dir, 'gestures.json'),
    `${JSON.stringify(results, null, 2)}\n`,
  )
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
const summary = []
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

  capture(path.join(out, 'after-browser/browser.txt'), [
    'shell',
    'am',
    'start',
    '-W',
    '-a',
    'android.intent.action.VIEW',
    '-d',
    'https://example.com',
  ])
  await sleep(5000)
  summary.push(await recordTap('after-browser'))

  await consoleGestures(path.join(out, 'after-gestures'))
  summary.push(await recordTap('after-gestures'))
  summary.push(await recordTap('again-1'))
  summary.push(await recordTap('again-2'))

  capture(path.join(out, 'stylus-off/setting.txt'), [
    'shell',
    'settings',
    'put',
    'secure',
    'stylus_handwriting_enabled',
    '0',
  ])
  summary.push(await recordTap('stylus-off'))
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
