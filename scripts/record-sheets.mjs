// Records the sheets that `loupe dismiss` must close on Android, and what
// each way to close them does: the probe app in Expo Go on its /sheets
// route, with the system share sheet, an alert, a modal, the keyboard and the
// permission dialog of the app, and the notification shade and the quick
// settings of the system. Each round opens one sheet and closes it one way:
//
// - back: the Back key;
// - outside: a tap in the upper part of the screen, outside the sheet, where
//   the probe app has nothing;
// - collapse: `cmd statusbar collapse` (the shade and the quick settings).
//
// The round `nothing/back` sends Back with no sheet open: the probe app
// counts each Back that reaches it. Before, while open and after, it keeps
// the window in front, the display dump, a uiautomator dump and a
// screenshot; while open also the window list, the input method state, and
// what `loupe ui` gives with and without `--app`. The "Sheet fixtures"
// workflow runs it in CI.
//
// Run it from the root of the repository, after `pnpm install` and the
// build, on one booted emulator with a clean system image. Don't run it on a
// phone: it installs Expo Go, starts Metro, revokes a permission of Expo Go,
// and opens the notification shade.
//
// Usage: node scripts/record-sheets.mjs <out-dir>
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
  focus,
  keepTimeout,
  loupe,
  probeOf,
  showRoute,
} from './lib/recorder.mjs'

const [out] = process.argv.slice(2)
if (!out) {
  console.error('Usage: node scripts/record-sheets.mjs <out-dir>')
  process.exit(2)
}
mkdirSync(out, { recursive: true })

const ROUTE = '/sheets'
const CAMERA = 'android.permission.CAMERA'
const CHANGE_LIMIT_MS = 5000
const SETTLE_MS = 1500
// The same status lines as apps/probe-app/sheets.tsx.
const STATUS_IDS = [
  'share',
  'alert',
  'modal',
  'permission',
  'keyboard',
  'backs',
]

const tapId = (id) => (dir) =>
  keepJson(
    path.join(dir, 'open.loupe-tap.json'),
    loupe('tap', '--id', id, '--app', EXPO_GO),
  )
const statusBar = (command) => (dir) =>
  capture(path.join(dir, 'open.statusbar.txt'), [
    'shell',
    'cmd',
    'statusbar',
    command,
  ])

// The keyboard stays up after a failed close, and a revoke stops Expo Go: so
// the keyboard and the permission go last.
const SHEETS = [
  { name: 'nothing', open: () => {}, ways: ['back'] },
  { name: 'share', open: tapId('open-share'), ways: ['back', 'outside'] },
  { name: 'alert', open: tapId('open-alert'), ways: ['back', 'outside'] },
  { name: 'modal', open: tapId('open-modal'), ways: ['back', 'outside'] },
  {
    name: 'shade',
    open: statusBar('expand-notifications'),
    ways: ['back', 'collapse'],
  },
  {
    name: 'quick-settings',
    open: statusBar('expand-settings'),
    ways: ['back', 'collapse'],
  },
  { name: 'keyboard', open: tapId('field'), ways: ['back'] },
  {
    name: 'permission',
    open: tapId('open-permission'),
    ways: ['back', 'outside'],
    revoke: true,
  },
]

let failures = 0

function fail(what) {
  failures += 1
  console.error(`FAIL: ${what}`)
}

function keepJson(file, envelope) {
  writeFileSync(file, `${JSON.stringify(envelope, null, 2)}\n`)
  return envelope
}

/** The text of the element with this resource-id in a uiautomator dump. */
function textOf(dump, id) {
  return (
    new RegExp(`text="([^"]*)" resource-id="${id}"`).exec(dump)?.[1] ?? 'none'
  )
}

/** The status lines of the probe app, in one line. */
const statusOf = (dump) => STATUS_IDS.map((id) => textOf(dump, id)).join('; ')

/** The window in front, the display and the screen, as `<name>.*`. */
function keepState(dir, name) {
  writeFileSync(path.join(dir, `${name}.focus.txt`), `${focus()}\n`)
  capture(path.join(dir, `${name}.dumpsys-window-displays.txt`), [
    'shell',
    'dumpsys',
    'window',
    'displays',
  ])
  capture(path.join(dir, `${name}.input-method.txt`), [
    'shell',
    'dumpsys',
    'input_method',
  ])
  const dump = dumpUi()
  writeFileSync(path.join(dir, `${name}.ui-tty.txt`), dump)
  capture(path.join(dir, `${name}.png`), ['exec-out', 'screencap', '-p'])
  return dump
}

/** A point in the upper part of the screen in px, from `wm size`. */
function outsidePoint() {
  const size = adbText(['shell', 'wm', 'size'])
  const [, width = '0', height = '0'] =
    /(?:Override|Physical) size: (\d+)x(\d+)/.exec(size) ?? []
  return [Math.round(Number(width) / 2), Math.round(Number(height) * 0.2)]
}

function close(way, dir) {
  const file = path.join(dir, `close.${way}.txt`)
  switch (way) {
    case 'back':
      capture(file, ['shell', 'input', 'keyevent', 'KEYCODE_BACK'])
      return
    case 'outside': {
      const [x, y] = outsidePoint()
      writeFileSync(path.join(dir, 'close.outside-point.txt'), `${x} ${y}\n`)
      capture(file, ['shell', 'input', 'tap', String(x), String(y)])
      return
    }
    case 'collapse':
      capture(file, ['shell', 'cmd', 'statusbar', 'collapse'])
      return
  }
}

/**
 * Waits until the window in front is `want` (or isn't, with `away`), for
 * up to 5 s; gives the time in ms, or undefined.
 */
async function waitForFocus(want, away) {
  const start = Date.now()
  while (Date.now() - start < CHANGE_LIMIT_MS) {
    if ((focus() === want) !== away) return Date.now() - start
    await sleep(250)
  }
  return undefined
}

/** Revokes the camera permission, so the next request shows the dialog. */
function revoke(dir) {
  capture(path.join(dir, 'prepare.revoke.txt'), [
    'shell',
    'pm',
    'revoke',
    EXPO_GO,
    CAMERA,
  ])
  capture(path.join(dir, 'prepare.clear-flags.txt'), [
    'shell',
    'pm',
    'clear-permission-flags',
    EXPO_GO,
    CAMERA,
    'user-set',
    'user-fixed',
  ])
}

function keepPermission(dir, name) {
  capture(path.join(dir, `${name}.package.txt`), [
    'shell',
    'dumpsys',
    'package',
    EXPO_GO,
  ])
}

async function recordRound(sheet, way) {
  const dir = path.join(out, sheet.name, way)
  mkdirSync(dir, { recursive: true })
  // A shade that an earlier round left open would cover this one.
  capture(path.join(dir, 'prepare.collapse.txt'), [
    'shell',
    'cmd',
    'statusbar',
    'collapse',
  ])
  if (sheet.revoke) revoke(dir)
  const log = []
  const shown = await showRoute(ROUTE, 'ltr', undefined, 180_000, log)
  writeFileSync(path.join(dir, 'prepare.txt'), `${log.join('\n')}\n`)
  if (!shown.matched) {
    keepTimeout(path.join(dir, 'prepare'), shown.dump)
    fail(`${sheet.name}/${way}: the probe app never showed ${ROUTE}`)
    return `${sheet.name}/${way}: not run`
  }

  const before = keepState(dir, 'before')
  const app = focus()
  if (sheet.revoke) keepPermission(dir, 'before')
  sheet.open(dir)
  const openMs = await waitForFocus(app, true)
  await sleep(SETTLE_MS)
  keepState(dir, 'open')
  const openFocus = focus()
  capture(path.join(dir, 'open.dumpsys-window-windows.txt'), [
    'shell',
    'dumpsys',
    'window',
    'windows',
  ])
  keepJson(
    path.join(dir, 'open.loupe-ui-app.json'),
    loupe('ui', '--app', EXPO_GO),
  )
  keepJson(path.join(dir, 'open.loupe-ui.json'), loupe('ui'))

  close(way, dir)
  const backMs = await waitForFocus(app, false)
  await sleep(SETTLE_MS)
  const after = keepState(dir, 'after')
  if (sheet.revoke) keepPermission(dir, 'after')
  const afterFocus = focus()
  // A sheet that stayed open hides the probe from the next round's route
  // check, so each later round would time out behind it.
  if (afterFocus !== app || !probeOf(after)) {
    capture(path.join(dir, 'cleanup.force-stop.txt'), [
      'shell',
      'am',
      'force-stop',
      EXPO_GO,
    ])
  }

  const line = [
    `${sheet.name}/${way}`,
    `app: ${app}`,
    `open: ${openFocus} (${openMs === undefined ? 'focus unchanged' : `${openMs} ms`})`,
    `after: ${afterFocus} (${backMs === undefined ? 'app not back' : `${backMs} ms`})`,
    `before: ${statusOf(before)}`,
    `after: ${statusOf(after)}`,
  ].join('\n  ')
  console.log(line)
  return line
}

capture(path.join(out, 'host/adb-devices-l.txt'), ['devices', '-l'])
capture(path.join(out, 'device/getprop.txt'), ['shell', 'getprop'])
capture(path.join(out, 'device/navigation-mode.txt'), [
  'shell',
  'settings',
  'get',
  'secure',
  'navigation_mode',
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

  for (const sheet of SHEETS) {
    for (const way of sheet.ways) {
      summary.push(await recordRound(sheet, way))
    }
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error))
} finally {
  writeFileSync(path.join(out, 'summary.txt'), `${summary.join('\n')}\n`)
  if (metro) await stopMetro(metro)
  capture(path.join(out, 'expo-go/collapse-end.txt'), [
    'shell',
    'cmd',
    'statusbar',
    'collapse',
  ])
  capture(path.join(out, 'expo-go/force-stop-end.txt'), [
    'shell',
    'am',
    'force-stop',
    EXPO_GO,
  ])
}

console.log(
  failures === 0
    ? 'Each round is recorded.'
    : `${failures} rounds or steps failed.`,
)
process.exit(failures === 0 ? 0 : 1)
