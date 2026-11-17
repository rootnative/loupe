// Records how an app goes to the background and comes back on Android, for
// `loupe background` and `loupe foreground`: Settings with a sub-page open,
// and the probe app in Expo Go on its /appstate route. Each round puts the
// app in front, presses HOME, waits, and brings the app back one way:
//
// - launcher: the intent of the launcher icon, as a tap on the icon sends;
// - base-intent: the base intent of the app's most recent task, from
//   `dumpsys activity recents`, sent again;
// - recents-twice: the Recents key two times;
// - recents-tap: the Recents key, then a tap in the middle of the screen;
// - move-task: `am stack move-task` with the id of the app's most recent
//   task, to the top of the stack that `am stack list` gives for it;
// - task-lock: `am task lock` with that id, then `am task lock stop`.
//
// Before and after each step it keeps the window in front, the activities,
// the recent tasks, a uiautomator dump and a screenshot. The probe app shows
// the run of its bundle (a reload gives a new one), each AppState, and the
// links after the first, so the dump tells if the app kept its state. The
// "App switch fixtures" workflow runs it in CI.
//
// Run it from the root of the repository, after `pnpm install` and the
// build, on one booted emulator with a clean system image. Don't run it on a
// phone: it installs Expo Go, starts Metro, and presses HOME and the Recents
// key.
//
// Usage: node scripts/record-app-switch.mjs <out-dir>
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
  showRoute,
} from './lib/recorder.mjs'

const [out] = process.argv.slice(2)
if (!out) {
  console.error('Usage: node scripts/record-app-switch.mjs <out-dir>')
  process.exit(2)
}
mkdirSync(out, { recursive: true })

const METHODS = [
  'launcher',
  'base-intent',
  'recents-twice',
  'recents-tap',
  'move-task',
  'task-lock',
]
const SETTINGS = 'com.android.settings'
const ROUTE = '/appstate'
const BACKGROUND_MS = 2000
const BACK_LIMIT_MS = 10_000

let failures = 0

function fail(what) {
  failures += 1
  console.error(`FAIL: ${what}`)
}

/** A value for the device shell: `adb shell` joins its arguments. */
const quote = (value) => `'${value.replaceAll("'", `'\\''`)}'`

/** The text of the element with this resource-id in a uiautomator dump. */
function textOf(dump, id) {
  return (
    new RegExp(`text="([^"]*)" resource-id="${id}"`).exec(dump)?.[1] ?? 'none'
  )
}

/** What the probe app on /appstate shows, in one line. */
function appStateOf(dump) {
  return `${textOf(dump, 'run')}; ${textOf(dump, 'app-states')}; ${textOf(dump, 'links')}`
}

/** The window in front, the tasks and the screen, as `<name>.*` in `dir`. */
function keepState(dir, name) {
  writeFileSync(path.join(dir, `${name}.focus.txt`), `${focus()}\n`)
  capture(path.join(dir, `${name}.activities.txt`), [
    'shell',
    'dumpsys',
    'activity',
    'activities',
  ])
  capture(path.join(dir, `${name}.recents.txt`), [
    'shell',
    'dumpsys',
    'activity',
    'recents',
  ])
  const dump = dumpUi()
  writeFileSync(path.join(dir, `${name}.ui-tty.txt`), dump)
  capture(path.join(dir, `${name}.png`), ['exec-out', 'screencap', '-p'])
  return dump
}

/**
 * The most recent task of `app` in `dumpsys activity recents`: its id (the
 * `#` number of its `Task{…}`) and its base intent (the text between the
 * braces of its `intent=` line).
 */
function recentTaskOf(recents, app) {
  for (const task of recents.split(/\n(?=\s*\* Recent #\d+:)/)) {
    const intent = /\n\s*intent=\{(.*)\}\s*(?:\n|$)/.exec(task)?.[1]
    if (intent && /\bcmp=(\S+)/.exec(intent)?.[1]?.startsWith(`${app}/`)) {
      return { id: /Task\{\S+ #(\d+)/.exec(task)?.[1], intent }
    }
  }
  return undefined
}

/**
 * The stack (a root task from Android 12) that holds the task, from `am
 * stack list`: the block that lists `taskId=<id>:`.
 */
function stackOf(list, taskId) {
  for (const block of list.split(/\n(?=(?:Stack|RootTask) id=)/)) {
    if (block.includes(`taskId=${taskId}:`)) {
      return /^(?:Stack|RootTask) id=(\d+)/.exec(block)?.[1]
    }
  }
  return undefined
}

/** `am start -W` with the parts of an intent from `dumpsys`. */
function amStartOf(intent) {
  const parts = ['am', 'start', '-W']
  const act = /\bact=(\S+)/.exec(intent)?.[1]
  const cats = /\bcat=\[([^\]]*)\]/.exec(intent)?.[1]
  const dat = /\bdat=(\S+)/.exec(intent)?.[1]
  const flg = /\bflg=(0x[0-9a-f]+)/.exec(intent)?.[1]
  const cmp = /\bcmp=(\S+)/.exec(intent)?.[1]
  if (act) parts.push('-a', quote(act))
  for (const cat of cats?.split(',') ?? []) parts.push('-c', quote(cat))
  if (dat) parts.push('-d', quote(dat))
  if (flg) parts.push('-f', flg)
  if (cmp) parts.push('-n', quote(cmp))
  return parts.join(' ')
}

/** The middle of the screen in px, from `wm size`. */
function middle() {
  const size = adbText(['shell', 'wm', 'size'])
  const [, width = '0', height = '0'] =
    /(?:Override|Physical) size: (\d+)x(\d+)/.exec(size) ?? []
  return [Math.round(Number(width) / 2), Math.round(Number(height) / 2)]
}

/** Brings `app` back from the home screen one way, and keeps what it sent. */
async function bringBack(method, app, dir) {
  const file = (name) => path.join(dir, `${method}.${name}`)
  switch (method) {
    case 'launcher': {
      const resolved = capture(file('resolve.txt'), [
        'shell',
        'cmd',
        'package',
        'resolve-activity',
        '--brief',
        '-c',
        'android.intent.category.LAUNCHER',
        app,
      ])
      const component = String(resolved.stdout).trim().split('\n').at(-1)
      capture(file('am-start.txt'), [
        'shell',
        `am start -W -a android.intent.action.MAIN -c android.intent.category.LAUNCHER -f 0x10200000 -n ${quote(component ?? app)}`,
      ])
      return
    }
    case 'base-intent': {
      const intent = recentTaskOf(
        adbText(['shell', 'dumpsys', 'activity', 'recents']),
        app,
      )?.intent
      writeFileSync(file('intent.txt'), `${intent ?? 'none'}\n`)
      if (intent) {
        const command = amStartOf(intent)
        writeFileSync(file('command.txt'), `${command}\n`)
        capture(file('am-start.txt'), ['shell', command])
      }
      return
    }
    case 'recents-twice':
    case 'recents-tap': {
      capture(file('key.txt'), [
        'shell',
        'input',
        'keyevent',
        'KEYCODE_APP_SWITCH',
      ])
      await sleep(1500)
      writeFileSync(file('overview.ui-tty.txt'), dumpUi())
      capture(file('overview.png'), ['exec-out', 'screencap', '-p'])
      const [x, y] = middle()
      capture(
        file('second.txt'),
        method === 'recents-twice'
          ? ['shell', 'input', 'keyevent', 'KEYCODE_APP_SWITCH']
          : ['shell', 'input', 'tap', String(x), String(y)],
      )
      return
    }
    case 'move-task':
    case 'task-lock': {
      const task = recentTaskOf(
        adbText(['shell', 'dumpsys', 'activity', 'recents']),
        app,
      )
      writeFileSync(file('task.txt'), `${task?.id ?? 'none'}\n`)
      if (!task?.id) return
      if (method === 'move-task') {
        const list = capture(file('stack-list.txt'), [
          'shell',
          'am',
          'stack',
          'list',
        ])
        const stack = stackOf(String(list.stdout), task.id) ?? task.id
        capture(file('am.txt'), [
          'shell',
          'am',
          'stack',
          'move-task',
          task.id,
          stack,
          'true',
        ])
        return
      }
      capture(file('am.txt'), ['shell', 'am', 'task', 'lock', task.id])
      await sleep(1000)
      capture(file('stop.txt'), ['shell', 'am', 'task', 'lock', 'stop'])
      return
    }
  }
}

/** Waits until a window of `app` has the focus; gives the time in ms. */
async function waitForApp(app) {
  const start = Date.now()
  while (Date.now() - start < BACK_LIMIT_MS) {
    if (focus().includes(app)) return Date.now() - start
    await sleep(250)
  }
  return undefined
}

/**
 * One round of each method: `prepare` puts the app in front in its state
 * and gives true when it did; then HOME, the wait, the way back.
 */
async function recordRounds(name, app, prepare, describe) {
  const summary = []
  for (const method of METHODS) {
    const dir = path.join(out, name, method)
    mkdirSync(dir, { recursive: true })
    if (!(await prepare(dir))) {
      fail(`${name}/${method}: the app isn't in its state before the round`)
      continue
    }
    const before = keepState(dir, 'before')
    capture(path.join(dir, 'home.key.txt'), [
      'shell',
      'input',
      'keyevent',
      'KEYCODE_HOME',
    ])
    await sleep(BACKGROUND_MS)
    writeFileSync(path.join(dir, 'home.focus.txt'), `${focus()}\n`)
    capture(path.join(dir, 'home.recents.txt'), [
      'shell',
      'dumpsys',
      'activity',
      'recents',
    ])

    await bringBack(method, app, dir)
    const ms = await waitForApp(app)
    await sleep(1500)
    const after = keepState(dir, 'after')
    summary.push(
      [
        method,
        `back after ${ms ?? 'no'} ms`,
        `in front: ${focus()}`,
        `before: ${describe(before)}`,
        `after: ${describe(after)}`,
      ].join('\n  '),
    )
    console.log(`${name}/${method}: ${ms ?? 'not'} back`)
  }
  writeFileSync(path.join(out, name, 'summary.txt'), `${summary.join('\n')}\n`)
}

/** Settings with "Network & internet" open: a page on top of the home page. */
async function prepareSettings(dir) {
  if (focus().includes('SubSettings')) return true
  capture(path.join(dir, 'prepare.am-start.txt'), [
    'shell',
    'am',
    'start',
    '-W',
    '-a',
    'android.settings.SETTINGS',
  ])
  await sleep(2000)
  if (focus().includes('SubSettings')) return true
  loupe('tap', '--text', 'Network & internet', '--app', SETTINGS)
  const start = Date.now()
  while (Date.now() - start < 10_000) {
    if (focus().includes('SubSettings')) return true
    await sleep(250)
  }
  return false
}

capture(path.join(out, 'host/adb-devices-l.txt'), ['devices', '-l'])
capture(path.join(out, 'device/getprop.txt'), ['shell', 'getprop'])
capture(path.join(out, 'device/am-help.txt'), ['shell', 'am', 'help'])
capture(path.join(out, 'device/navigation-mode.txt'), [
  'shell',
  'settings',
  'get',
  'secure',
  'navigation_mode',
])

capture(path.join(out, 'settings/force-stop.txt'), [
  'shell',
  'am',
  'force-stop',
  SETTINGS,
])
await recordRounds('settings', SETTINGS, prepareSettings, (dump) =>
  dump.includes('text="Internet"') || dump.includes('text="Wi‑Fi"')
    ? 'the network page'
    : 'another screen',
)

let metro
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

  const openLog = []
  const first = await showRoute(ROUTE, 'ltr', undefined, 300_000, openLog)
  mkdirSync(path.join(out, 'expo-go'), { recursive: true })
  writeFileSync(
    path.join(out, 'expo-go', 'open.txt'),
    `${openLog.join('\n')}\n`,
  )
  if (!first.matched) {
    fail(`the probe app never showed ${ROUTE}`)
    keepTimeout(path.join(out, 'expo-go', 'open-timeout'), first.dump)
  } else {
    await recordRounds(
      'expo-go',
      EXPO_GO,
      async (dir) => {
        const log = []
        const shown = await showRoute(ROUTE, 'ltr', undefined, 120_000, log)
        writeFileSync(path.join(dir, 'prepare.txt'), `${log.join('\n')}\n`)
        if (!shown.matched) keepTimeout(path.join(dir, 'prepare'), shown.dump)
        return shown.matched
      },
      appStateOf,
    )
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error))
} finally {
  if (metro) await stopMetro(metro)
  capture(path.join(out, 'expo-go/lock-stop-end.txt'), [
    'shell',
    'am',
    'task',
    'lock',
    'stop',
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
