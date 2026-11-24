// Records what the Expo helpers of loupe must handle, on a clean emulator
// (round 10): the probe app's Metro, Expo Go before and after its install,
// the screens that hide the app on the first open, four ways to reload the
// app, and the switch to RTL through the app config while Metro runs. The
// "Expo fixtures" workflow runs it in CI.
//
// - expo-go/: what `open-url` gives with no Expo Go, then the version of
//   the installed one.
// - metro/: `/status`, the manifest that Expo Go asks for, and the launch
//   bundle cold, warm, after an edit of a source file, and after the edit
//   is undone: the time, size, type and SHA-256 of each.
// - open/: the first open of /appstate, each screen that hid the app, and
//   the time until the probe shows.
// - reload/<way>-<n>/: the probe app on /appstate, then one way to reload
//   it (WAYS): the run before and after, and each screen that hid the app.
// - rtl/: the manifest after an edit of app.json while Metro runs, then
//   each way with the edit (to RTL) and with the edit undone (to LTR).
//
// Each wait writes a line per read to its `log.txt`, and each part a line
// per round to its `summary.txt`. A way that doesn't work is data: the
// script fails only when a part or a round can't run.
//
// Run it from the root of the repository, after `pnpm install` and the
// build, on one booted emulator with a clean system image. Don't run it on a
// phone: it installs Expo Go and starts Metro. It edits two files of the
// probe app for a while, and puts each back.
//
// Usage: node scripts/record-expo.mjs <out-dir> <api-level>
// With more than one device, set ANDROID_SERIAL to the emulator first.

import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import {
  EXPO_GO,
  installExpoGo,
  PORT,
  PROBE_APP,
  startMetro,
  stopMetro,
} from './lib/expo-go.mjs'
import {
  ADB,
  adbText,
  capture,
  dumpUi,
  focus,
  loupe,
  probeOf,
} from './lib/recorder.mjs'
import { settle } from './lib/settle.mjs'

const [out, level] = process.argv.slice(2)
if (!out || !level) {
  console.error('Usage: node scripts/record-expo.mjs <out-dir> <api-level>')
  process.exit(2)
}
mkdirSync(out, { recursive: true })

const BASE = `http://127.0.0.1:${PORT}`
const LINK = `exp://127.0.0.1:${PORT}`
const ROUTE = '/appstate'
const ROUTE_LINK = `${LINK}/--${ROUTE}`
const WAYS = ['menu-key', 'double-r', 'message', 'force-stop']
const ROUNDS = 2
// A reload that works shows a new run in seconds. A cold start of Expo Go
// can take a minute, and in RTL on API 34+ a second open (round 6).
const RELOAD_LIMIT_MS = 45_000
const COLD_LIMIT_MS = 120_000
const OPEN_AGAIN_MS = 20_000
const APP_JSON = path.join(PROBE_APP, 'app.json')
const SOURCE = path.join(PROBE_APP, 'index.ts')
// The headers of the manifest request of Expo Go.
const MANIFEST_HEADERS = {
  'expo-platform': 'android',
  accept: 'application/expo+json,application/json',
}

let failures = 0

function fail(what) {
  failures += 1
  console.error(`FAIL: ${what}`)
}

/** Writes the lines to `file`, and makes its folder. */
function writeLines(file, lines) {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, `${lines.join('\n')}\n`)
}

/** Writes a summary, and prints it for the CI log. */
function report(file, lines) {
  writeLines(file, lines)
  for (const line of lines) console.log(line)
}

/** The text of the element with this resource-id in a uiautomator dump. */
function textOf(dump, id) {
  return (
    new RegExp(`text="([^"]*)" resource-id="${id}"`).exec(dump)?.[1] ?? 'none'
  )
}

/**
 * The screen in a dump that hides the app, and the loupe command that
 * closes it, as an agent does.
 */
function blockerOf(dump) {
  if (dump.includes('resource-id="android:id/aerr_wait"')) {
    return {
      name: 'not-responding',
      close: ['tap', '--id', 'android:id/aerr_wait'],
    }
  }
  if (dump.includes('text="Continue"')) {
    return {
      name: 'onboarding',
      close: ['tap', '--text', 'Continue', '--app', EXPO_GO],
    }
  }
  if (dump.includes('text="Go home"')) {
    return {
      name: 'dev-menu',
      close: ['tap', '--label', 'Close', '--app', EXPO_GO],
    }
  }
  return undefined
}

/** Keeps the focus, a dump and a screenshot as `<name>.*` in `dir`. */
function keep(dir, name) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, `${name}.focus.txt`), `${focus()}\n`)
  const dump = dumpUi()
  writeFileSync(path.join(dir, `${name}.ui-tty.txt`), dump)
  capture(path.join(dir, `${name}.png`), ['exec-out', 'screencap', '-p'])
  return dump
}

/** Opens a link in Expo Go with loupe, and keeps its JSON in `file`. */
function openLink(file, link = ROUTE_LINK) {
  const opened = loupe('open-url', link, '--app', EXPO_GO)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(opened, null, 2)}\n`)
  return opened
}

/**
 * Reads the screen until `done(probe, run)` gives true, for up to `limit`
 * ms. Each screen that hides the app is kept once in `dir` and closed. With
 * `link`, the link goes again each 20 s while no probe shows. Gives the
 * time (undefined after the limit), the last probe and run, and the names
 * of the screens that hid the app.
 */
async function untilShown(dir, log, { done, limit, link }) {
  mkdirSync(dir, { recursive: true })
  const start = Date.now()
  let openedAt = start
  const hid = new Set()
  let probe
  let run = 'none'
  while (Date.now() - start < limit) {
    const dump = dumpUi()
    probe = probeOf(dump)
    run = textOf(dump, 'run')
    const ms = Date.now() - start
    log.push(
      `${ms} ms: ${focus()}; probe ${probe ? `${probe.route} ${probe.direction}` : 'none'}; ${run}`,
    )
    if (probe && done(probe, run)) return { ms, probe, run, hid: [...hid] }

    const blocker = blockerOf(dump)
    if (blocker) {
      if (!hid.has(blocker.name)) {
        hid.add(blocker.name)
        writeFileSync(path.join(dir, `${blocker.name}.ui-tty.txt`), dump)
        capture(path.join(dir, `${blocker.name}.png`), [
          'exec-out',
          'screencap',
          '-p',
        ])
      }
      const closed = loupe(...blocker.close)
      log.push(
        `${ms} ms: close ${blocker.name}: ${closed.ok ? 'ok' : closed.error?.code}`,
      )
    } else if (link && !probe && Date.now() - openedAt >= OPEN_AGAIN_MS) {
      const again = loupe('open-url', link, '--app', EXPO_GO)
      log.push(
        `${ms} ms: open again: ${again.ok ? (again.data.activity ?? 'ok') : again.error?.code}`,
      )
      openedAt = Date.now()
    }
    await sleep(500)
  }
  return { ms: undefined, probe, run, hid: [...hid] }
}

const hidBy = ({ hid }) => (hid.length ? `; hid by ${hid.join(', ')}` : '')

/** A client frame of RFC 6455: FIN, the opcode, the payload masked. */
function frame(opcode, payload) {
  const mask = randomBytes(4)
  const header =
    payload.length < 126
      ? Buffer.from([0x80 | opcode, 0x80 | payload.length])
      : Buffer.from([
          0x80 | opcode,
          0x80 | 126,
          payload.length >> 8,
          payload.length & 0xff,
        ])
  const masked = payload.map((byte, index) => byte ^ mask[index % 4])
  return Buffer.concat([header, mask, masked])
}

/**
 * Sends one message on Metro's /message socket, as the `r` key of Expo
 * CLI does: an upgrade with no Origin header (Metro trusts a local socket
 * with none), one text frame, then a close. Node 20 has no global
 * WebSocket, and loupe supports it. Gives the answer to the upgrade.
 */
function sendMessage(message) {
  return new Promise((resolve) => {
    const upgrade = request({
      host: '127.0.0.1',
      port: PORT,
      path: '/message',
      headers: {
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-version': '13',
        'sec-websocket-key': randomBytes(16).toString('base64'),
      },
    })
    upgrade.setTimeout(10_000, () => {
      upgrade.destroy()
      resolve('timeout')
    })
    upgrade.on('upgrade', (response, socket) => {
      socket.write(frame(0x1, Buffer.from(JSON.stringify(message))))
      socket.end(frame(0x8, Buffer.alloc(0)))
      resolve(`${response.statusCode} ${response.statusMessage}`)
    })
    upgrade.on('response', (response) => {
      response.resume()
      resolve(`${response.statusCode} ${response.statusMessage}, no upgrade`)
    })
    upgrade.on('error', (error) => resolve(`error: ${error.message}`))
    upgrade.end()
  })
}

/** Reloads the app one way, and keeps what it sent in `dir`. */
async function reload(way, dir, log) {
  mkdirSync(dir, { recursive: true })
  const file = (name) => path.join(dir, `${way}.${name}`)
  switch (way) {
    case 'menu-key': {
      capture(file('key.txt'), ['shell', 'input', 'keyevent', 'KEYCODE_MENU'])
      let dump = ''
      for (let tries = 0; tries < 10; tries += 1) {
        await sleep(500)
        dump = dumpUi()
        if (dump.includes('text="Reload"')) break
      }
      writeFileSync(file('menu.ui-tty.txt'), dump)
      capture(file('menu.png'), ['exec-out', 'screencap', '-p'])
      if (!dump.includes('text="Reload"')) {
        log.push('menu-key: no "Reload" on the screen')
        return
      }
      const tap = loupe('tap', '--text', 'Reload', '--app', EXPO_GO)
      writeFileSync(file('tap.json'), `${JSON.stringify(tap, null, 2)}\n`)
      return
    }
    case 'double-r':
      capture(file('key.txt'), [
        'shell',
        'input',
        'keyevent',
        'KEYCODE_R',
        'KEYCODE_R',
      ])
      return
    case 'message': {
      const answer = await sendMessage({ version: 2, method: 'reload' })
      writeFileSync(file('answer.txt'), `${answer}\n`)
      log.push(`message: ${answer}`)
      return
    }
    case 'force-stop':
      capture(file('force-stop.txt'), ['shell', 'am', 'force-stop', EXPO_GO])
      openLink(file('open-url.json'))
      return
  }
}

const limitOf = (way) =>
  way === 'force-stop' ? COLD_LIMIT_MS : RELOAD_LIMIT_MS
const linkOf = (way) => (way === 'force-stop' ? ROUTE_LINK : undefined)

async function recordExpoGo() {
  const dir = path.join(out, 'expo-go')
  capture(path.join(dir, 'pm-path-before.txt'), [
    'shell',
    'pm',
    'path',
    EXPO_GO,
  ])
  const missing = openLink(path.join(dir, 'missing.open-url.json'), LINK)
  const sdk = await installExpoGo(ADB)
  capture(path.join(dir, 'pm-path.txt'), ['shell', 'pm', 'path', EXPO_GO])
  const packageDump = capture(path.join(dir, 'dumpsys-package.txt'), [
    'shell',
    'dumpsys',
    'package',
    EXPO_GO,
  ])
  const version = /versionName=(\S+)/.exec(String(packageDump.stdout))?.[1]
  report(path.join(dir, 'summary.txt'), [
    `With no Expo Go, open-url gives ${missing.ok ? 'ok' : `${missing.error?.code}: ${missing.error?.message}`}`,
    `Expo Go for SDK ${sdk}: versionName ${version ?? 'none'}`,
  ])
}

/** Waits until Metro answers `/status`, and gives the answer. */
async function untilMetroRuns(metro) {
  const start = Date.now()
  for (;;) {
    if (metro.exitCode !== null) {
      throw new Error('Metro stopped. See metro.log.')
    }
    const status = await fetch(`${BASE}/status`)
      .then((response) => response.text())
      .catch(() => '')
    if (status.includes('packager-status:running')) return status
    if (Date.now() - start > 180_000) {
      throw new Error("Metro didn't start in 3 minutes. See metro.log.")
    }
    await sleep(1000)
  }
}

/** The manifest as Expo Go asks for it, kept as `<name>.*` in `dir`. */
async function keepManifest(dir, name) {
  const response = await fetch(BASE, { headers: MANIFEST_HEADERS })
  const body = await response.text()
  writeLines(path.join(dir, `${name}.headers.txt`), [
    `${response.status} ${response.statusText}`,
    ...[...response.headers].map(([key, value]) => `${key}: ${value}`),
  ])
  writeFileSync(path.join(dir, `${name}.json`), body)
  return JSON.parse(body)
}

async function fetchBundle(url) {
  const start = performance.now()
  const response = await fetch(url, { signal: AbortSignal.timeout(600_000) })
  const body = Buffer.from(await response.arrayBuffer())
  return {
    status: response.status,
    ms: Math.round(performance.now() - start),
    bytes: body.length,
    type: response.headers.get('content-type') ?? 'none',
    sha256: createHash('sha256').update(body).digest('hex'),
  }
}

/** Fetches the bundle until its hash isn't `previous`: 5 tries, 2 s apart. */
async function untilBundleChanges(url, previous) {
  let bundle
  let tries = 0
  while (tries < 5) {
    tries += 1
    await sleep(2000)
    bundle = await fetchBundle(url)
    if (bundle.sha256 !== previous) break
  }
  return { ...bundle, tries }
}

const describeBundle = (name, bundle) =>
  `${name}: ${bundle.status}, ${bundle.ms} ms, ${bundle.bytes} bytes, ${bundle.type}, sha256 ${bundle.sha256}`

async function recordMetro(metro) {
  const dir = path.join(out, 'metro')
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'status.txt'), await untilMetroRuns(metro))
  const manifest = await keepManifest(dir, 'manifest')
  const url = manifest.launchAsset?.url
  if (!url) throw new Error('The manifest has no launchAsset.url.')

  const cold = await fetchBundle(url)
  const warm = await fetchBundle(url)
  const source = readFileSync(SOURCE, 'utf8')
  let edited
  try {
    writeFileSync(SOURCE, `${source}\nexport const roundTen = ${Date.now()}\n`)
    edited = await untilBundleChanges(url, warm.sha256)
  } finally {
    writeFileSync(SOURCE, source)
  }
  const restored = await untilBundleChanges(url, edited.sha256)
  report(path.join(dir, 'summary.txt'), [
    `Launch asset: ${url}`,
    describeBundle('cold', cold),
    describeBundle('warm', warm),
    `${describeBundle('edited', edited)}; ${edited.tries} tries`,
    `${describeBundle('restored', restored)}; ${restored.tries} tries; the same as warm: ${restored.sha256 === warm.sha256 ? 'yes' : 'no'}`,
  ])
}

async function recordFirstOpen() {
  const dir = path.join(out, 'open')
  const log = []
  capture(path.join(dir, 'reverse.txt'), [
    'reverse',
    `tcp:${PORT}`,
    `tcp:${PORT}`,
  ])
  openLink(path.join(dir, 'open-url.json'))
  try {
    const shown = await untilShown(dir, log, {
      done: (probe) => probe.route === ROUTE,
      limit: 300_000,
      link: ROUTE_LINK,
    })
    if (shown.ms === undefined) {
      keep(dir, 'timeout')
      throw new Error(`The probe app never showed ${ROUTE}.`)
    }
    // A sheet can show a moment after the app (M1b.4): watch for 10 s.
    log.push('watch for 10 s')
    const late = await untilShown(path.join(dir, 'late'), log, {
      done: () => false,
      limit: 10_000,
    })
    keep(dir, 'shown')
    report(path.join(dir, 'summary.txt'), [
      `First open: ${ROUTE} after ${shown.ms} ms${hidBy(shown)}`,
      `In the 10 s after: ${late.hid.length ? `hid by ${late.hid.join(', ')}` : 'nothing hid the app'}`,
    ])
  } finally {
    writeLines(path.join(dir, 'log.txt'), log)
  }
}

/** Puts the probe app on /appstate, with the link when it isn't there. */
async function prepareRoute(dir, log) {
  if (probeOf(dumpUi())?.route === ROUTE) return true
  openLink(path.join(dir, 'open-url.json'))
  const shown = await untilShown(dir, log, {
    done: (probe) => probe.route === ROUTE,
    limit: COLD_LIMIT_MS,
    link: ROUTE_LINK,
  })
  return shown.ms !== undefined
}

async function recordReloads() {
  const summary = []
  for (const way of WAYS) {
    for (let round = 1; round <= ROUNDS; round += 1) {
      const dir = path.join(out, 'reload', `${way}-${round}`)
      const log = []
      try {
        if (!(await prepareRoute(path.join(dir, 'prepare'), log))) {
          fail(`reload/${way}-${round}: the app isn't on ${ROUTE}`)
          continue
        }
        const before = textOf(keep(dir, 'before'), 'run')
        await reload(way, dir, log)
        // A new run, or a new route: either needs a new start of the JS.
        const shown = await untilShown(dir, log, {
          done: (probe, run) =>
            probe.route !== ROUTE || (run !== 'none' && run !== before),
          limit: limitOf(way),
          link: linkOf(way),
        })
        // The probe app shows / until its first link arrives.
        await sleep(2000)
        const after = keep(dir, 'after')
        summary.push(
          `${way}-${round}: ${shown.ms === undefined ? `no new run in ${limitOf(way) / 1000} s` : `new run after ${shown.ms} ms`} (${before} → ${textOf(after, 'run')}); route ${probeOf(after)?.route ?? 'no probe'}${hidBy(shown)}`,
        )
      } finally {
        writeLines(path.join(dir, 'log.txt'), log)
      }
    }
  }
  report(path.join(out, 'reload', 'summary.txt'), summary)
}

/** The probe app's app.json with RTL on. */
function rtlConfig(appJson) {
  const config = JSON.parse(appJson)
  config.expo.extra = {
    ...config.expo.extra,
    supportsRTL: true,
    forcesRTL: true,
  }
  return `${JSON.stringify(config, null, 2)}\n`
}

/** The `extra` of the app config in a manifest. */
const extraOf = (manifest) =>
  JSON.stringify(manifest.extra?.expoClient?.extra ?? null)

/**
 * Shows the app in `direction`: when it isn't, the config for it, a
 * force-stop and the link, as round 6 did.
 */
async function prepareDirection(dir, log, direction, appJson) {
  if (probeOf(dumpUi())?.direction === direction) return true
  writeFileSync(APP_JSON, direction === 'rtl' ? rtlConfig(appJson) : appJson)
  capture(path.join(dir, 'force-stop.txt'), [
    'shell',
    'am',
    'force-stop',
    EXPO_GO,
  ])
  openLink(path.join(dir, 'open-url.json'))
  const shown = await untilShown(dir, log, {
    done: (probe) => probe.direction === direction,
    limit: COLD_LIMIT_MS,
    link: ROUTE_LINK,
  })
  return shown.ms !== undefined
}

async function recordRtl(appJson) {
  const dir = path.join(out, 'rtl')
  const summary = []
  const before = await keepManifest(dir, 'manifest-ltr')
  summary.push(`Manifest before the edit: extra ${extraOf(before)}`)
  writeFileSync(APP_JSON, rtlConfig(appJson))
  await sleep(1000)
  const soon = await keepManifest(dir, 'manifest-rtl-1s')
  summary.push(`Manifest 1 s after the edit: extra ${extraOf(soon)}`)
  await sleep(9000)
  const later = await keepManifest(dir, 'manifest-rtl-10s')
  summary.push(`Manifest 10 s after the edit: extra ${extraOf(later)}`)
  writeFileSync(APP_JSON, appJson)

  for (const way of WAYS) {
    for (const direction of ['rtl', 'ltr']) {
      const wayDir = path.join(dir, `${way}-${direction}`)
      const log = []
      const from = direction === 'rtl' ? 'ltr' : 'rtl'
      try {
        const ready = await prepareDirection(
          path.join(wayDir, 'prepare'),
          log,
          from,
          appJson,
        )
        if (!ready) {
          fail(`rtl/${way}-${direction}: the app isn't in ${from}`)
          continue
        }
        keep(wayDir, 'before')
        writeFileSync(
          APP_JSON,
          direction === 'rtl' ? rtlConfig(appJson) : appJson,
        )
        await reload(way, wayDir, log)
        const shown = await untilShown(wayDir, log, {
          done: (probe) => probe.direction === direction,
          limit: limitOf(way),
          link: linkOf(way),
        })
        await sleep(2000)
        const after = probeOf(keep(wayDir, 'after'))
        summary.push(
          `${way} to ${direction}: ${shown.ms === undefined ? `still ${after?.direction ?? 'no probe'} after ${limitOf(way) / 1000} s` : `${direction} after ${shown.ms} ms`}; route ${after?.route ?? 'no probe'}${hidBy(shown)}`,
        )
      } finally {
        writeLines(path.join(wayDir, 'log.txt'), log)
      }
    }
  }
  report(path.join(dir, 'summary.txt'), summary)
}

capture(path.join(out, 'host/adb-devices-l.txt'), ['devices', '-l'])
capture(path.join(out, 'device/getprop.txt'), ['shell', 'getprop'])
await settle((...args) => adbText(['shell', ...args]), Number(level))

const appJson = readFileSync(APP_JSON, 'utf8')
let metro
try {
  await recordExpoGo()
  metro = startMetro(path.join(out, 'metro.log'))
  await recordMetro(metro)
  await recordFirstOpen()
  await recordReloads()
  await recordRtl(appJson)
} catch (error) {
  fail(error instanceof Error ? error.message : String(error))
} finally {
  writeFileSync(APP_JSON, appJson)
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
    ? 'Each part is recorded.'
    : `${failures} parts or rounds failed.`,
)
process.exit(failures === 0 ? 0 : 1)
