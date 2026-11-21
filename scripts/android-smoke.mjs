// Runs the built loupe CLI on one booted emulator with a clean system image,
// and checks each result. The "Android smoke" job of the CI workflow runs it
// after the build, on the lowest and the newest API level. It reads the JSON
// on a pipe, as an agent does.
//
// At the end it opens the probe app (apps/probe-app) in Expo Go, and checks
// that the safe area of the probe is the system's in portrait and in both
// landscapes, then the theme, the app switch and the sheets that `dismiss`
// closes. For that it downloads Expo Go from Expo, and starts Metro on
// localhost. Last comes the gate of the checks: each defect pattern of the
// probe app must fail its rule and each fixed twin must pass, in LTR with
// `sweep`, then in RTL (Metro again with PROBE_APP_RTL=1) with `check
// --mirror-of` against the LTR screens.
//
// A busy emulator can show an "isn't responding" dialog over the app under
// test. The run closes it as an agent does, with `loupe dismiss`, keeps a
// screenshot and the ANR lines of logcat, and runs the step once more.
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
const NOT_RESPONDING = 'Application Not Responding: '
const VARIANTS = ['defect', 'fixed']

// The gate: the rule that the defect of each probe app pattern must fail in
// LTR. Its fixed twin passes every rule. The two `sides` screens differ only
// in RTL, so in LTR both pass.
const GATE_RULES = {
  inset: 'inset',
  sheet: 'inset',
  sides: undefined,
  overflow: 'overflow',
  target: 'touch-target',
  centred: 'centred',
}
// On API 30 in landscape the uiautomator tree ends short of the screen, and
// loupe can't see these defects past that cut (round 6).
const API_30_BLIND = new Set(['overflow', 'target', 'centred', 'sides'])
// The screens of the RTL part, each against its LTR run: [orientation,
// pattern]. In RTL, the defect of each must fail `mirrored`.
const MIRROR_SCREENS = [
  ['portrait', 'mirrored'],
  ['landscape-left', 'mirrored'],
  ['landscape-left', 'sides'],
]

let failures = 0
let runs = 0
let dialogs = 0

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
 * and no window has the focus in that time. An "isn't responding" dialog
 * closes, 3 at most, and each one starts the 15 s again.
 */
async function waitForFocus(part) {
  const start = Date.now()
  let since = start
  let closed = 0
  let seen = focus()
  while (!seen.includes(part) && Date.now() - since < 15_000) {
    if (closed < 3 && closeNotResponding(`the wait for ${part}`)) {
      closed += 1
      since = Date.now()
    } else {
      await sleep(500)
    }
    seen = focus()
  }
  return { seen: seen || 'no window', ms: Date.now() - start }
}

/**
 * Closes the "isn't responding" dialog that has the focus, if one has it:
 * keeps a screenshot and the ANR lines of logcat, then runs `loupe
 * dismiss`, which taps Wait. Gives true when the dialog closed.
 */
function closeNotResponding(during) {
  const title = focus()
  if (!title.startsWith(NOT_RESPONDING)) return false
  dialogs += 1
  keepScreen(`not-responding-${dialogs}.png`)
  try {
    writeFileSync(
      path.join(out, `not-responding-${dialogs}.logcat.txt`),
      adb('logcat', '-d', '-s', 'ActivityManager:E'),
    )
  } catch (error) {
    console.log(`No logcat for dialog ${dialogs}: ${error.message}`)
  }
  const closed = runLoupe('dismiss')
  console.log(
    `"${title}" showed during ${during}: ${closed.ok ? 'loupe dismiss closed it' : "loupe dismiss didn't close it"} (dialog ${dialogs}).`,
  )
  return closed.ok
}

/** A screenshot through adb, for a check that failed. */
function keepScreen(name) {
  const result = spawnSync(ADB, ['exec-out', 'screencap', '-p'], {
    timeout: 60_000,
  })
  if (result.status === 0) writeFileSync(path.join(out, name), result.stdout)
}

/**
 * Runs one command (`runLoupe`). When it gives `app_not_in_front` because
 * an "isn't responding" dialog has the focus, it closes the dialog and runs
 * the command once more.
 */
function loupe(...args) {
  const result = runLoupe(...args)
  if (
    result.error?.code !== 'app_not_in_front' ||
    !closeNotResponding(`loupe ${args[0]}`)
  ) {
    return result
  }
  console.log(`loupe ${args[0]} runs once more.`)
  return runLoupe(...args)
}

/** Runs one command, keeps its JSON, and gives the result and the exit code. */
function runLoupe(...args) {
  const result = spawnSync(process.execPath, [BIN, ...args, '--json'], {
    encoding: 'utf8',
    // The gate's sweep opens and checks 24 screens in one call.
    timeout: 600_000,
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

// With `wanted`, the link goes again this often while nothing shows: on
// Android 14 and later, a cold start of Expo Go in RTL lands on its home
// screen, and the second open shows the app (round 6).
const OPEN_AGAIN_MS = 20_000

/**
 * Reads the screen with `loupe ui` until the probe shows, for up to `limit`
 * ms; with `wanted`, until it shows that route in that direction, and the
 * link goes again every 20 s. On the first open, Expo Go shows its developer
 * menu: a sheet with a "Continue" button, then the menu with a "Close"
 * button. A busy emulator can show an "isn't responding" dialog for another
 * app. The dump of each has none of the app, so loupe taps each button, as
 * an agent does.
 */
async function waitForProbe(limit, wanted) {
  const start = Date.now()
  let openedAt = start
  let screen
  do {
    screen = loupe('ui')
    const probe = screen.data?.probe
    if (
      probe &&
      (!wanted ||
        (probe.route === wanted.route && probe.direction === wanted.direction))
    ) {
      return { screen, ms: Date.now() - start }
    }

    const nodes = screen.data?.nodes ?? []
    const has = (test) => findNode(nodes, test) !== undefined
    if (has((node) => node.id === 'android:id/aerr_wait')) {
      loupe('tap', '--id', 'android:id/aerr_wait')
    } else if (has((node) => node.text === 'Continue')) {
      loupe('tap', '--text', 'Continue', '--app', EXPO_GO)
    } else if (has((node) => node.text === 'Go home')) {
      loupe('tap', '--label', 'Close', '--app', EXPO_GO)
    } else if (wanted && Date.now() - openedAt >= OPEN_AGAIN_MS) {
      console.log(`The focus is on ${focus()}: the link goes again.`)
      loupe('open-url', wanted.link, '--app', EXPO_GO)
      openedAt = Date.now()
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
  checkSweep()
  checkSweepScroll()
  checkGateSweep()
  const ltr = saveLtrScreens()
  checkTheme()
  await checkAppState()
  await checkSheets()
  return ltr
}

/**
 * `sweep` on the probe app's centred pattern, in portrait and one landscape:
 * 4 screens with no error, the defect found in portrait and its fixed twin
 * passed in both, a screenshot for each screen, a contact sheet for each
 * variant, and the screen in portrait again at the end.
 */
function checkSweep() {
  const folder = path.join(out, 'sweep')
  const link = (variant) => `exp://127.0.0.1:${PORT}/--/centred/${variant}`
  const swept = loupe(
    'sweep',
    '--url',
    link('defect'),
    '--url',
    link('fixed'),
    '--orientation',
    'portrait,landscape-left',
    '--out',
    folder,
    '--app',
    EXPO_GO,
  )
  const data = swept.data
  const failures = data?.failures ?? []
  const errors = failures.filter((failure) => failure.error)
  const sheets = (data?.variants ?? []).map(({ sheet }) => pngSize(sheet))
  let report
  try {
    report = JSON.parse(readFileSync(path.join(folder, 'report.json'), 'utf8'))
  } catch {
    report = undefined
  }
  const shots = (report?.screens ?? []).map(({ screenshot }) =>
    screenshot ? pngSize(screenshot) : undefined,
  )
  const passed =
    swept.exit === 1 &&
    data?.screens === 4 &&
    errors.length === 0 &&
    failures.some(
      ({ number, variant, rules }) =>
        number === 1 &&
        variant.startsWith('portrait-') &&
        rules.includes('centred'),
    ) &&
    failures.every(({ number }) => number === 1) &&
    sheets.length === 2 &&
    sheets.every(Boolean) &&
    shots.length === 4 &&
    shots.every(Boolean) &&
    data.warnings.length === 0 &&
    loupe('ui', '--app', EXPO_GO).data?.orientation === 'portrait'
  check(
    passed,
    `sweep: 2 links × 2 orientations, the centred defect found and its twin passed (exit ${swept.exit}; ${data?.screens} screens; failed: ${failures.map(({ number, variant, rules, error }) => `${number} ${variant} ${error ?? rules.join('+')}`).join(', ') || 'none'}; ${sheets.filter(Boolean).length} sheets; ${shots.filter(Boolean).length} screenshots)`,
  )
  if (!passed) keepScreen('sweep.png')
}

/**
 * `sweep --scroll` on the probe app's long list: the close button shows
 * only after a scroll. The defect is found on the scrolled screen alone,
 * each screen comes back to its top with no warning, and the list shows
 * its first row at the end.
 */
function checkSweepScroll() {
  const folder = path.join(out, 'sweep-scroll')
  const link = (variant) => `exp://127.0.0.1:${PORT}/--/scroll/${variant}`
  const swept = loupe(
    'sweep',
    '--url',
    link('defect'),
    '--url',
    link('fixed'),
    '--scroll',
    '--out',
    folder,
    '--app',
    EXPO_GO,
  )
  const data = swept.data
  const failures = data?.failures ?? []
  let report
  try {
    report = JSON.parse(readFileSync(path.join(folder, 'report.json'), 'utf8'))
  } catch {
    report = undefined
  }
  const screens = report?.screens ?? []
  const warnings = screens.flatMap((screen) => screen.warnings)
  const sheet = data?.variants?.[0]?.scrolledSheet
  const nodes = loupe('ui', '--app', EXPO_GO).data?.nodes ?? []
  const firstRow = findNode(nodes, (node) => node.id === 'row-1')
  const passed =
    swept.exit === 1 &&
    data?.screens === 4 &&
    screens.map((screen) => screen.scrolled).join() ===
      'false,true,false,true' &&
    failures.length === 1 &&
    failures[0].number === 1 &&
    failures[0].scrolled === true &&
    failures[0].rules.join() === 'touch-target' &&
    !failures[0].error &&
    warnings.length === 0 &&
    sheet !== undefined &&
    pngSize(sheet) !== undefined &&
    firstRow !== undefined
  check(
    passed,
    `sweep --scroll: the defect found after the scroll only, each screen back at its top (exit ${swept.exit}; ${data?.screens} screens; failed: ${failures.map(({ number, scrolled, rules, error }) => `${number}${scrolled ? ' scrolled' : ''} ${error ?? rules.join('+')}`).join(', ') || 'none'}; warnings: ${warnings.join(' ') || 'none'}; first row ${firstRow ? 'shown' : 'not shown'})`,
  )
  if (!passed) keepScreen('sweep-scroll.png')
}

function patternLink(pattern, variant) {
  return `exp://127.0.0.1:${PORT}/--/${pattern}/${variant}`
}

/** Opens a pattern screen, and waits for its caption. */
function openPattern(pattern, variant) {
  return loupe(
    'open-url',
    patternLink(pattern, variant),
    '--app',
    EXPO_GO,
    '--wait-text',
    `${pattern} · ${variant}`,
  )
}

/**
 * One screen of the gate: a fixed twin passes every rule, and a defect fails
 * `rule`. A defect that loupe can't see on API 30 in landscape is a note,
 * not a failure.
 */
function checkGateScreen(name, { pattern, variant, orientation, rule }, run) {
  const shown = run.error ?? (run.failed.join(', ') || 'each rule passed')
  if (run.error) {
    check(false, `gate: ${name}: ${shown}`)
  } else if (variant === 'fixed' || !rule) {
    check(run.failed.length === 0, `gate: ${name} passes every rule (${shown})`)
  } else if (
    !run.failed.includes(rule) &&
    apiLevel === 30 &&
    orientation !== 'portrait' &&
    API_30_BLIND.has(pattern)
  ) {
    console.log(
      `note: gate: ${name} doesn't fail ${rule}: on API 30 in landscape the tree ends short, a known limit (${shown})`,
    )
  } else {
    check(run.failed.includes(rule), `gate: ${name} fails ${rule} (${shown})`)
  }
}

function failedRules(screenCheck) {
  return (screenCheck?.results ?? [])
    .filter((result) => !result.passed)
    .map((result) => result.rule)
}

/**
 * The LTR part of the gate: one `sweep` of each pattern but `mirrored`, both
 * variants, in portrait and landscape-left.
 */
function checkGateSweep() {
  const folder = path.join(out, 'gate')
  const links = Object.keys(GATE_RULES).flatMap((pattern) =>
    VARIANTS.map((variant) => patternLink(pattern, variant)),
  )
  const swept = loupe(
    'sweep',
    ...links.flatMap((link) => ['--url', link]),
    '--orientation',
    'portrait,landscape-left',
    '--out',
    folder,
    '--app',
    EXPO_GO,
  )
  let report
  try {
    report = JSON.parse(readFileSync(path.join(folder, 'report.json'), 'utf8'))
  } catch {
    report = undefined
  }
  const screens = report?.screens ?? []
  check(
    swept.exit === 1 && screens.length === links.length * 2,
    `gate: sweep of ${links.length} links in 2 orientations (exit ${swept.exit}; ${screens.length} screens)`,
  )
  const orientations = Object.fromEntries(
    (report?.variants ?? []).map(({ name, orientation }) => [
      name,
      orientation,
    ]),
  )
  for (const screen of screens) {
    const [pattern, variant] = screen.url.split('/--/')[1].split('/')
    const orientation = orientations[screen.variant]
    checkGateScreen(
      `${pattern}/${variant} in ${orientation}`,
      { pattern, variant, orientation, rule: GATE_RULES[pattern] },
      { failed: failedRules(screen.check), error: screen.error?.code },
    )
  }
}

/**
 * Saves `loupe ui` of each screen of the RTL part, in LTR, for `check
 * --mirror-of`. Gives each file by `<pattern>/<variant> <orientation>`.
 */
function saveLtrScreens() {
  const files = {}
  for (const [orientation, pattern] of MIRROR_SCREENS) {
    loupe('rotate', orientation)
    for (const variant of VARIANTS) {
      const name = `${pattern}/${variant} ${orientation}`
      openPattern(pattern, variant)
      const screen = loupe('ui', '--app', EXPO_GO)
      const probe = screen.data?.probe
      const saved =
        probe?.route === `/${pattern}/${variant}` &&
        probe.direction === 'ltr' &&
        screen.data.orientation === orientation
      check(saved, `gate: ${name} saved in LTR`)
      if (!saved) continue
      const file = path.join(
        out,
        `ltr-${pattern}-${variant}-${orientation}.json`,
      )
      writeFileSync(file, JSON.stringify(screen.data))
      files[name] = file
    }
  }
  loupe('rotate', 'portrait')
  return files
}

/**
 * The RTL part of the gate. Metro starts again with PROBE_APP_RTL=1, which
 * sets forcesRTL, and Expo Go stops, because it applies forcesRTL when it
 * loads the app. Then `check --mirror-of` on each screen against its LTR
 * file. The new Metro goes into `metros`, so the caller stops it.
 */
async function checkGateRtl(metros, files) {
  await stopMetro(metros[0])
  const metro = startMetro(path.join(out, 'metro-rtl.log'), {
    PROBE_APP_RTL: '1',
  })
  metros.push(metro)
  const warm = await warmMetro(metro)
  adb('shell', 'am', 'force-stop', EXPO_GO)

  const [, firstPattern] = MIRROR_SCREENS[0]
  const link = patternLink(firstPattern, 'defect')
  const route = `/${firstPattern}/defect`
  loupe('open-url', link, '--app', EXPO_GO)
  const first = await waitForProbe(180_000, { route, direction: 'rtl', link })
  const probe = first.screen.data?.probe
  const shown = probe?.route === route && probe.direction === 'rtl'
  check(
    shown,
    `gate: the probe app in RTL after ${first.ms} ms (Metro warm after ${warm} ms)`,
  )
  if (!shown) {
    keepScreen('gate-rtl-timeout.png')
    return
  }

  for (const [orientation, pattern] of MIRROR_SCREENS) {
    loupe('rotate', orientation)
    for (const variant of VARIANTS) {
      const name = `${pattern}/${variant} ${orientation}`
      const file = files[name]
      if (!file) {
        check(false, `gate: ${name} in RTL: no LTR screen to compare`)
        continue
      }
      openPattern(pattern, variant)
      const checked = loupe('check', '--mirror-of', file, '--app', EXPO_GO)
      checkGateScreen(
        `${pattern}/${variant} in ${orientation}, RTL`,
        { pattern, variant, orientation, rule: 'mirrored' },
        {
          failed: failedRules(checked.data),
          error: checked.ok ? undefined : checked.error.code,
        },
      )
    }
  }
  loupe('rotate', 'portrait')
}

/**
 * `theme` on the probe app's first screen: dark, then light again, each
 * shown by the probe's colour scheme. The emulator starts and ends light.
 */
function checkTheme() {
  const dark = loupe('theme', 'dark', '--app', EXPO_GO)
  const read = loupe('theme')
  const light = loupe('theme', 'light', '--app', EXPO_GO)
  const shown = (result) =>
    result.ok
      ? `${result.data.source}, ${result.data.ms} ms`
      : result.error.code
  check(
    dark.data?.was === 'light' &&
      dark.data.source === 'probe' &&
      read.data?.theme === 'dark' &&
      light.data?.was === 'dark' &&
      light.data.source === 'probe',
    `theme: dark (${shown(dark)}), then light (${shown(light)}), each shown by the probe`,
  )
  if (!dark.ok || !light.ok) keepScreen('theme.png')
}

/** What the probe app shows on /appstate: its run, AppStates and links. */
function appState() {
  const nodes = loupe('ui', '--app', EXPO_GO).data?.nodes ?? []
  const text = (id) => findNode(nodes, (node) => node.id === id)?.text
  return { run: text('run'), states: text('app-states'), links: text('links') }
}

/**
 * Expo Go runs each app in a task of its own. `background --for` must bring
 * that task back with the same run of the app: one more `background
 * active`, and no new link.
 */
async function checkAppState() {
  loupe('open-url', `exp://127.0.0.1:${PORT}/--/appstate`, '--app', EXPO_GO)
  loupe('wait', '--id', 'run', '--app', EXPO_GO)
  const before = appState()
  const away = loupe('background', '--for', '1500', '--app', EXPO_GO)
  let after = appState()
  for (let read = 0; read < 10 && after.states === before.states; read += 1) {
    await sleep(500)
    after = appState()
  }
  check(
    away.data?.back?.way === 'recents' &&
      before.run !== undefined &&
      after.run === before.run &&
      after.links === before.links &&
      after.states === `${before.states} background active`,
    `background --for 1500: the probe app is back in the same run (${away.data?.back?.way ?? away.error?.code}; ${before.run}, ${before.states} → ${after.run}, ${after.states}; ${after.links})`,
  )
  if (!away.ok) keepScreen('background-expo-go.png')
}

/** The status lines of the probe app on /sheets. */
function sheetStatus() {
  const nodes = loupe('ui', '--app', EXPO_GO).data?.nodes ?? []
  const text = (id) => findNode(nodes, (node) => node.id === id)?.text
  return { share: text('share'), alert: text('alert'), backs: text('backs') }
}

/** The layers that `dismiss` closed, as `layer/way`, or its error code. */
function closedBy(result) {
  if (!result.ok) return result.error.code
  return (
    result.data.closed.map(({ layer, way }) => `${layer}/${way}`).join(', ') ||
    'none'
  )
}

/**
 * Keeps the state of the screen as `<name>.*` in the output dir: the
 * windows, the input method, the input devices, the settings, a dump and a
 * screenshot. The emulator is a clean one, so the settings hold no one's
 * data.
 */
function keepState(name) {
  const keep = (file, ...args) => {
    const result = spawnSync(ADB, args, {
      encoding: 'utf8',
      timeout: 60_000,
      maxBuffer: 64 * 1024 * 1024,
    })
    writeFileSync(path.join(out, `${name}.${file}`), result.stdout ?? '')
  }
  keep('displays.txt', 'shell', 'dumpsys', 'window', 'displays')
  keep('windows.txt', 'shell', 'dumpsys', 'window', 'windows')
  keep('input-method.txt', 'shell', 'dumpsys', 'input_method')
  keep('input.txt', 'shell', 'dumpsys', 'input')
  keep('settings-secure.txt', 'shell', 'settings', 'list', 'secure')
  keep('settings-global.txt', 'shell', 'settings', 'list', 'global')
  keep('ui-tty.txt', 'exec-out', 'uiautomator', 'dump', '/dev/tty')
  keepScreen(`${name}.png`)
}

/**
 * `dismiss`, then a wait for a status line, as two commands: a wait that
 * runs out must not drop the result of `dismiss`.
 */
function dismissThenWait(status, ...options) {
  const result = loupe('dismiss', ...options, '--app', EXPO_GO)
  const shown = loupe('wait', '--text', status, '--app', EXPO_GO).ok
  return { result, shown }
}

/** Runs one check; when it fails, keeps the state of the screen. */
function checkSheet(passed, what, name) {
  check(passed, what)
  if (!passed) keepState(`sheets-${name}`)
}

/**
 * Gboard's stylus mode (API 35+, round 9b): stylus handwriting on again, a
 * drag through the console on the home screen, the probe app's / and then
 * /sheets, then the field. `dismiss --all` closes the "Try out your stylus"
 * sheet when it shows (a tap on Cancel), then the handwriting toolbar with
 * Escape, so no Back reaches the app: the step reads `backs` itself, as the
 * new /sheets starts the count again. The setting stays on: this is the
 * last touch.
 *
 * Gboard takes the stylus mode only for a session that the tap itself
 * starts, on a field with no focus before it (`CHECK_FOCUS` in
 * `mStartInputHistory`; round 9b, CI run 44391789676). After the keyboard
 * step the field keeps its focus: a link to /sheets keeps the field (CI
 * run 44741581304), and the app back from the home screen starts a session
 * on window focus, not on the tap (CI run 44742938051). / unmounts the
 * field, so the /sheets after it has a new one with no focus.
 */
async function checkStylus() {
  adb('shell', 'settings', 'put', 'secure', 'stylus_handwriting_enabled', '1')
  loupe('key', 'home')
  await sleep(2000)
  const drag = loupe(
    'drag',
    String(x + 100),
    String(y),
    String(x - 100),
    String(y),
  )
  loupe('open-url', `exp://127.0.0.1:${PORT}/--/`, '--app', EXPO_GO)
  loupe('wait', '--label', 'safe area', '--app', EXPO_GO)
  loupe('open-url', `exp://127.0.0.1:${PORT}/--/sheets`, '--app', EXPO_GO)
  loupe('wait', '--id', 'backs', '--app', EXPO_GO)
  keepState('stylus-before')
  loupe('tap', '--id', 'field', '--app', EXPO_GO)
  const opened = loupe('wait', '--text', 'keyboard shown', '--app', EXPO_GO)
  keepState('stylus-open')
  const stylus = dismissThenWait('keyboard hidden', '--all')
  const ways = closedBy(stylus.result)
  checkSheet(
    drag.ok &&
      opened.ok &&
      ['keyboard/escape', 'stylus-sheet/tap-cancel, keyboard/escape'].includes(
        ways,
      ) &&
      stylus.shown,
    `dismiss --all in the stylus mode: the sheet with a tap on Cancel when it shows, then the keyboard with Escape (drag ${drag.ok ? 'ok' : drag.error?.code}; keyboard shown ${opened.ok ? 'showed' : 'missing'}; ${ways}; keyboard hidden ${stylus.shown ? 'shows' : 'missing'})`,
    'stylus',
  )

  const { backs } = sheetStatus()
  checkSheet(
    backs === 'backs 0',
    `dismiss in the stylus mode: no Back reached the app (${backs})`,
    'stylus-backs',
  )
}

/**
 * `dismiss` on the probe app's /sheets: nothing open (no key), the
 * notification shade over the share sheet (--all), an alert, then the
 * keyboard. The app counts each Back that reaches it, and must count none.
 *
 * The keyboard goes last: the field keeps the focus after it, and Android
 * 11 shows the keyboard again each time the app gets the focus back. That
 * step keeps the state each time: it needs the plain keyboard, see
 * `stylus_handwriting_enabled` below. On API 35+ the stylus step comes
 * after the `backs` check.
 */
async function checkSheets() {
  loupe('open-url', `exp://127.0.0.1:${PORT}/--/sheets`, '--app', EXPO_GO)
  loupe('wait', '--id', 'backs', '--app', EXPO_GO)

  const nothing = loupe('dismiss', '--app', EXPO_GO)
  checkSheet(
    closedBy(nothing) === 'none',
    `dismiss with nothing open sends no key (${closedBy(nothing)})`,
    'nothing',
  )

  loupe('tap', '--id', 'open-share', '--app', EXPO_GO)
  const share = await waitForFocus('ChooserActivity')
  adb('shell', 'cmd', 'statusbar', 'expand-notifications')
  const shade = await waitForFocus('NotificationShade')
  const both = dismissThenWait('share sharedAction', '--all')
  checkSheet(
    share.seen.includes('ChooserActivity') &&
      shade.seen.includes('NotificationShade') &&
      closedBy(both.result) ===
        'notification-shade/collapse, share-sheet/back' &&
      both.shown,
    `dismiss --all: the shade, then the share sheet (${closedBy(both.result)}; share sharedAction ${both.shown ? 'shows' : 'missing'})`,
    'share',
  )

  loupe('tap', '--id', 'open-alert', '--app', EXPO_GO)
  loupe('wait', '--text', 'Probe alert', '--app', EXPO_GO)
  const alert = dismissThenWait('alert dismissed')
  checkSheet(
    closedBy(alert.result) === 'app-dialog/back' && alert.shown,
    `dismiss: the alert closes with Back (${closedBy(alert.result)}; alert dismissed ${alert.shown ? 'shows' : 'missing'})`,
    'alert',
  )

  keepState('keyboard-before')
  loupe('tap', '--id', 'field', '--app', EXPO_GO)
  const opened = loupe('wait', '--text', 'keyboard shown', '--app', EXPO_GO)
  keepState('keyboard-open')
  const keyboard = dismissThenWait('keyboard hidden')
  checkSheet(
    opened.ok &&
      closedBy(keyboard.result) === 'keyboard/back' &&
      keyboard.shown,
    `dismiss: the keyboard closes with Back (keyboard shown ${opened.ok ? 'showed' : 'missing'}; ${closedBy(keyboard.result)}; keyboard hidden ${keyboard.shown ? 'shows' : 'missing'})`,
    'keyboard',
  )

  const status = sheetStatus()
  checkSheet(
    status.backs === 'backs 0',
    `dismiss: no Back reached the app (${status.backs}; ${status.share}; ${status.alert})`,
    'backs',
  )

  if (apiLevel >= 35) await checkStylus()
}

adb('wait-for-device')
await settle()
// Before any touch: to compare with the state at the keyboard step.
keepState('start')
// The touches of the emulator console come from a device with a STYLUS
// source. After them, Gboard on API 35+ shows its "Try out your stylus"
// sheet and a handwriting toolbar in place of the keyboard, and the Back
// that closes the toolbar also reaches the app. `checkStylus` turns it on
// again at the end, for the stylus step of `dismiss`.
adb('shell', 'settings', 'put', 'secure', 'stylus_handwriting_enabled', '0')
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

// The browser isn't a layer over Settings: no Back into it.
const other = loupe('dismiss', '--app', SETTINGS)
check(
  other.error?.code === 'app_not_in_front' &&
    other.error.message.includes(`loupe foreground ${SETTINGS}`),
  `dismiss: no key into another app, and a pointer to foreground (${other.error?.code ?? 'ok'})`,
)

// The browser is in front, so Settings isn't the most recent task: the way
// back is a task lock. From the home screen, it's the Recents key.
const fore = loupe('foreground', SETTINGS)
const foreFocus = await waitForFocus(SETTINGS)
check(
  fore.data?.way === 'task-lock' && foreFocus.seen.includes(SETTINGS),
  `foreground: Settings is in front again (${fore.data?.way ?? fore.error?.code}, ${fore.data?.ms} ms)`,
)
if (!fore.ok) keepScreen('foreground.png')

const away = loupe('background', '--for', '1500', '--app', SETTINGS)
check(
  away.data?.back?.way === 'recents' && focus().includes(SETTINGS),
  `background --for 1500: Settings is back (${away.data?.back?.way ?? away.error?.code}, away ${away.data?.away} ms)`,
)
if (!away.ok) keepScreen('background.png')

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
const metros = [startMetro(path.join(out, 'metro.log'))]
try {
  const ltr = await checkProbeApp(metros[0])
  if (ltr) await checkGateRtl(metros, ltr)
} catch (error) {
  check(false, `probe app: ${error instanceof Error ? error.message : error}`)
  keepScreen('probe-app-error.png')
} finally {
  for (const metro of metros) await stopMetro(metro)
}

console.log(
  failures === 0
    ? `All checks passed on API level ${apiLevel}.`
    : `${failures} checks failed on API level ${apiLevel}.`,
)
if (dialogs > 0) {
  console.log(
    `${dialogs} "isn't responding" ${dialogs === 1 ? 'dialog' : 'dialogs'} closed: see not-responding-*.png and *.logcat.txt.`,
  )
}
process.exit(failures === 0 ? 0 : 1)
