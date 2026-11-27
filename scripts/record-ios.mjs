// Recorder round 11: how loupe can drive an iOS simulator, on one macOS
// runner. Run it from the root of the repository after the build steps of
// ios-fixtures.yml, with DEVELOPER_DIR set to the job's Xcode:
//
//   node scripts/record-ios.mjs <out> --ios <version> --device <name>
//     --xcode <version> --build <dir> [--build-only]
//
// <dir> holds `simtool` (way A) and one `runner-<xcode>` folder for each
// Xcode that built the runner (way B): the derived data of `xcodebuild
// build-for-testing`. The parts, in order:
//
// 1. host/: the macOS, the Xcode, the simulators, the CPU slices.
// 2. simulator/: a new simulator, booted with no window.
// start/: each runner build started once (with --build-only, the end).
// 3. expo-go/: a link with no Expo Go, then the install.
// 4. Metro for the probe app, warmed for iOS.
// 5. b/: way B with no Simulator window: the first open, the screens in 3
//    orientations, touches, and Expo Go restarts and RTL.
// 6. a/: way A in a Simulator window: the same screens, turned with the
//    keyboard, and touches by HID event and by pid.
// 7. summary.txt.
//
// iOS asks "Open in “Expo Go”?" before a link opens Expo Go. Each way taps
// "Open" there, and counts those alerts for each link.
//
// A way that doesn't work is data, not a failure. The script fails when a
// part can't run, or when no runner starts.

import { spawnSync } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { parseArgs } from 'node:util'
import {
  PORT,
  PROBE_APP,
  startMetro,
  stopMetro,
  warmMetro,
} from './lib/expo-go.mjs'
import {
  captureTool,
  connectRunner,
  EXPO_GO_IOS,
  installExpoGoIos,
  iosRuntime,
  simctl,
  startRunner,
  stopRunner,
} from './lib/ios.mjs'

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    ios: { type: 'string' },
    device: { type: 'string' },
    xcode: { type: 'string' },
    build: { type: 'string' },
    'build-only': { type: 'boolean', default: false },
  },
})
const [out] = positionals
if (!out || !values.ios || !values.device || !values.xcode || !values.build) {
  throw new Error(
    'Usage: node scripts/record-ios.mjs <out> --ios <version> --device <name> --xcode <version> --build <dir> [--build-only]',
  )
}

const build = path.resolve(values.build)
const simtool = path.join(build, 'simtool')
const PRODUCTS = path.join('Build', 'Products')
const RUNNER_APP = path.join('Debug-iphonesimulator', 'LoupeRunner-Runner.app')
const FIRST_PORT = 22087
// The simulator's name; the Simulator window has it as its title.
const SIMULATOR = 'loupe-round-11'
const RUNNER_PORT = 22100

const ORIENTATIONS = ['portrait', 'landscapeLeft', 'landscapeRight']
const SCREENS = [
  '/',
  '/sheets',
  '/centred/defect',
  '/mirrored/defect',
  '/probe-channels',
]
// What each route shows, so a tree with no probe still tells the route.
const MARKERS = {
  '/': { text: 'Probe app' },
  '/sheets': { identifier: 'backs' },
  '/centred/defect': { text: 'centred · defect' },
  '/mirrored/defect': { text: 'mirrored · defect' },
  '/scroll/defect': { identifier: 'row-1' },
  '/appstate': { identifier: 'run' },
  '/probe-channels': { identifier: 'channels-caption' },
}
// Buttons that close a screen of Expo Go over the app, tried in this order.
const CLOSERS = ['Continue', 'Got it', 'Close', 'Dismiss']
// While the route doesn't show, the link goes again this often (round 10).
const OPEN_AGAIN_MS = 20_000
// The iPhone 16 Pro and the iPhone 17 Pro in portrait, when way B gives none.
const SCREEN_PT = { width: 402, height: 874 }

const summary = []
function note(line) {
  console.log(line)
  summary.push(line)
}

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}

const slug = (route) => route.replace(/^\//, '').replaceAll('/', '-') || 'root'
const link = (route) => `exp://127.0.0.1:${PORT}/--${route}`

function* nodesOf(tree) {
  if (!tree) return
  yield tree
  for (const child of tree.children ?? []) yield* nodesOf(child)
}

function find(tree, test) {
  for (const node of nodesOf(tree)) if (test(node)) return node
  return undefined
}

function matches(node, marker) {
  return marker.identifier
    ? node.identifier === marker.identifier
    : [node.label, node.title, node.value].includes(marker.text)
}

const isAppScreen = (tree) =>
  Object.values(MARKERS).some((marker) =>
    find(tree, (node) => matches(node, marker)),
  )

const textOf = (node) => node?.label ?? node?.value ?? node?.title

const centreOf = (frame) => ({
  x: frame.x + frame.width / 2,
  y: frame.y + frame.height / 2,
})

/**
 * The "Open" button of the alert that iOS shows before a link opens another
 * app, or undefined when the tree has no such alert.
 */
function linkAlertButton(tree, isButton) {
  const asked = find(tree, (node) => node.label?.startsWith('Open in '))
  return asked && find(tree, (node) => isButton(node) && node.label === 'Open')
}

/** Which probe channels a tree shows, and in which field. */
function probeChannels(tree) {
  const found = new Set()
  for (const node of nodesOf(tree)) {
    for (const field of ['identifier', 'label', 'title', 'value']) {
      const text = node[field]
      if (typeof text === 'string' && text.startsWith('loupe')) {
        found.add(`${text.slice(0, text.indexOf(':') + 1)} in ${field}`)
      }
    }
  }
  return [...found]
}

/** A short name for a screen: its first buttons and texts. */
function signature(tree) {
  const words = []
  for (const node of nodesOf(tree)) {
    if (['button', 'staticText'].includes(node.type) && node.label) {
      words.push(node.label)
    }
  }
  return words.slice(0, 8).join(' | ') || '(no button or text)'
}

let udid

function openLink(route, file) {
  const start = Date.now()
  // simctl openurl of an exp:// link can hang after it opens the link.
  const result = simctl(file, ['openurl', udid, link(route)], 8000)
  return {
    ms: Date.now() - start,
    status: result.status,
    stopped: result.error?.code === 'ETIMEDOUT',
  }
}

function simctlShot(file) {
  simctl(`${file}.txt`, ['io', udid, 'screenshot', `${file}.png`])
}

async function part(name, run) {
  try {
    return await run()
  } catch (error) {
    note(`${name}: stopped: ${error instanceof Error ? error.message : error}`)
    process.exitCode = 1
    return undefined
  }
}

function recordHost() {
  const host = path.join(out, 'host')
  captureTool(path.join(host, 'sw_vers.txt'), 'sw_vers', [])
  captureTool(path.join(host, 'uname-m.txt'), 'uname', ['-m'])
  captureTool(path.join(host, 'xcodebuild-version.txt'), 'xcodebuild', [
    '-version',
  ])
  captureTool(path.join(host, 'xcode-select.txt'), 'xcode-select', ['-p'])
  captureTool(path.join(host, 'simtool.lipo.txt'), 'lipo', ['-archs', simtool])
  const trusted = captureTool(
    path.join(host, 'simtool-trusted.json'),
    simtool,
    ['trusted'],
  )
  note(`simtool trusted: ${trusted.stdout.toString().trim()}`)
  const listed = simctl(path.join(host, 'simctl-list.json'), ['list', '--json'])
  if (listed.status !== 0) throw new Error('simctl list failed.')
  return JSON.parse(listed.stdout.toString())
}

/** Each runner build: the Xcode that made it and its `.xctestrun` file. */
function findRunners() {
  return readdirSync(build)
    .filter((name) => name.startsWith('runner-') && !name.endsWith('.log'))
    .sort()
    .map((name) => {
      const xcode = name.slice('runner-'.length)
      const products = path.join(build, name, PRODUCTS)
      let files = []
      try {
        files = readdirSync(products)
      } catch {
        // No products: the build failed, and its log says why.
      }
      const xctestrun = files.find((file) => file.endsWith('.xctestrun'))
      return {
        xcode,
        products,
        xctestrun: xctestrun && path.join(products, xctestrun),
      }
    })
}

function bootSimulator(list) {
  const runtime = iosRuntime(list, values.ios)
  if (!runtime) throw new Error(`No available iOS ${values.ios} runtime.`)
  const dir = path.join(out, 'simulator')
  const created = simctl(path.join(dir, 'create.txt'), [
    'create',
    SIMULATOR,
    values.device,
    runtime.identifier,
  ])
  if (created.status !== 0) throw new Error('simctl create failed.')
  const id = created.stdout.toString().trim()
  note(`simulator: ${values.device}, ${runtime.name}, ${id}`)

  const start = Date.now()
  simctl(path.join(dir, 'boot.txt'), ['boot', id])
  const booted = simctl(
    path.join(dir, 'bootstatus.txt'),
    ['bootstatus', id, '-b'],
    600_000,
  )
  note(`boot: ${Date.now() - start} ms, bootstatus exit ${booted.status}`)
  if (booted.status !== 0) throw new Error("The simulator didn't boot.")
  return id
}

/**
 * A request to the runner. A request with no answer closes the connection,
 * so the next request gets a new one.
 */
async function ask(runner, message, limit = 60_000) {
  try {
    return await runner.client.request(message, limit)
  } catch (error) {
    runner.client = (await connectRunner(runner.port)) ?? runner.client
    return { ok: false, error: String(error) }
  }
}

const appTree = (runner) => ask(runner, { cmd: 'tree', app: EXPO_GO_IOS })

async function shots(runner, file) {
  const shot = await ask(runner, { cmd: 'screenshot' })
  if (shot.ok) {
    writeFileSync(`${file}.png`, Buffer.from(shot.png, 'base64'))
  }
  simctlShot(`${file}.simctl`)
}

/** Starts one runner build on the simulator, asks a few things, and quits. */
async function startOnce({ xcode, products, xctestrun }, port) {
  const dir = path.join(out, 'start', `built-with-${xcode}`)
  mkdirSync(dir, { recursive: true })
  if (!xctestrun) {
    note(`built with Xcode ${xcode}: no build (see runner-${xcode}.log)`)
    return false
  }
  writeFileSync(path.join(dir, 'runner.xctestrun'), readFileSync(xctestrun))
  for (const [file, binary] of [
    ['runner.lipo.txt', path.join(RUNNER_APP, 'LoupeRunner-Runner')],
    [
      'test-bundle.lipo.txt',
      path.join(RUNNER_APP, 'PlugIns', 'LoupeRunner.xctest', 'LoupeRunner'),
    ],
  ]) {
    captureTool(path.join(dir, file), 'lipo', [
      '-archs',
      path.join(products, binary),
    ])
  }

  const runner = await startRunner({
    xctestrun,
    udid,
    port,
    logFile: path.join(dir, 'xcodebuild.log'),
  })
  if (runner.error) {
    note(`built with Xcode ${xcode}: ${runner.error} (${runner.ms} ms)`)
    await stopRunner(runner)
    return false
  }
  runner.port = port
  writeJson(path.join(dir, 'ping.json'), runner.ping)
  note(
    `built with Xcode ${xcode}: ping after ${runner.ms} ms (built with ${runner.ping.builtWith}, ${runner.ping.sdk}; ${runner.ping.os})`,
  )

  for (const [name, message] of [
    ['orientation', { cmd: 'orientation' }],
    ['springboard-state', { cmd: 'state' }],
    ['springboard-tree', { cmd: 'tree' }],
  ]) {
    const answer = await ask(runner, message)
    writeJson(path.join(dir, `${name}.json`), answer)
    note(`  ${name}: ${answer.ok ? 'ok' : answer.error}, ${answer.ms} ms`)
  }
  await shots(runner, path.join(dir, 'screenshot'))

  const exit = await stopRunner(runner)
  note(`  xcodebuild after quit: ${exit}`)
  return true
}

async function recordExpoGo() {
  const dir = path.join(out, 'expo-go')
  const before = openLink('/', path.join(dir, 'openurl-no-expo-go.txt'))
  note(
    `link with no Expo Go: exit ${before.status}${before.stopped ? ' (stopped after 8 s)' : ''}, ${before.ms} ms`,
  )
  simctlShot(path.join(dir, 'no-expo-go'))
  const installed = await installExpoGoIos(udid, dir)
  writeJson(path.join(dir, 'expo-go.json'), installed)
  note(
    `Expo Go ${installed.version} (${installed.bundleId}) for SDK ${installed.sdk}: ${installed.archs}, installed in ${installed.ms} ms`,
  )
}

/**
 * Opens the route in Expo Go, then reads Expo Go's tree each second until
 * the route's marker shows, for up to `limit` ms. Each other screen is kept
 * once. A screen of Expo Go over the app gets a tap on its first closer.
 * Else Springboard's tree is read: the alert that asks before the link
 * opens gets a tap on "Open", and the first one is kept. Else the link goes
 * again after 20 s. Gives the time, the opens, the link alerts, the last
 * tree when the route shows, and the screens on the way.
 */
async function showRoute(runner, route, dir, limit = 120_000) {
  mkdirSync(dir, { recursive: true })
  const start = Date.now()
  const log = []
  const seen = []
  let opens = 0
  let alerts = 0
  let openedAt = 0
  const open = () => {
    const opened = openLink(route, path.join(dir, `openurl-${++opens}.txt`))
    openedAt = Date.now()
    log.push(
      `${openedAt - start} ms: open ${opens} (${opened.stopped ? 'stopped after 8 s' : `exit ${opened.status}`}, ${opened.ms} ms)`,
    )
  }
  const finish = (result) => {
    writeFileSync(path.join(dir, 'wait.txt'), `${log.join('\n')}\n`)
    return { ...result, opens, alerts, screens: seen }
  }
  const acceptLink = async () => {
    const board = await ask(runner, { cmd: 'tree' })
    if (!board.ok) {
      log.push(
        `${Date.now() - start} ms: Springboard tree failed: ${board.error}`,
      )
      return false
    }
    const button = linkAlertButton(board.tree, (node) => node.type === 'button')
    if (!button) return false
    if (++alerts === 1) {
      writeJson(path.join(dir, 'link-alert.springboard.json'), board)
      await shots(runner, path.join(dir, 'link-alert'))
    }
    const tapped = await ask(runner, { cmd: 'tap', ...centreOf(button.frame) })
    // Expo Go starts only now, so the wait for the next open starts here.
    openedAt = Date.now()
    log.push(
      `${openedAt - start} ms: link alert ${alerts}: tap "Open": ${tapped.ok ? 'ok' : tapped.error}`,
    )
    return true
  }

  open()
  let last
  while (Date.now() - start < limit) {
    last = await appTree(runner)
    const ms = Date.now() - start
    let acted = false
    if (!last.ok) {
      log.push(`${ms} ms: tree failed: ${last.error}`)
    } else if (find(last.tree, (node) => matches(node, MARKERS[route]))) {
      log.push(`${ms} ms: ${route} shows (tree ${last.ms} ms)`)
      return finish({ ms, tree: last.tree })
    } else {
      const name = signature(last.tree)
      if (!seen.includes(name)) {
        seen.push(name)
        writeJson(path.join(dir, `screen-${seen.length}.tree.json`), last)
        await shots(runner, path.join(dir, `screen-${seen.length}`))
        log.push(`${ms} ms: screen ${seen.length}: ${name}`)
      }
      const closer =
        !isAppScreen(last.tree) &&
        CLOSERS.find((label) =>
          find(
            last.tree,
            (node) => node.type === 'button' && node.label === label,
          ),
        )
      if (closer) {
        const tapped = await ask(runner, {
          cmd: 'tap',
          app: EXPO_GO_IOS,
          label: closer,
        })
        log.push(
          `${Date.now() - start} ms: tap "${closer}": ${tapped.ok ? 'ok' : tapped.error}`,
        )
        acted = true
      }
    }
    acted ||= await acceptLink()
    if (!acted && Date.now() - openedAt >= OPEN_AGAIN_MS) open()
    await sleep(1000)
  }
  log.push(`${Date.now() - start} ms: ${route} didn't show`)
  writeJson(path.join(dir, 'last.tree.json'), last)
  return finish({ ms: Date.now() - start, tree: undefined })
}

function noteShown(prefix, route, shown) {
  note(
    `${prefix} ${route}: ${shown.tree ? 'shows' : "doesn't show"} after ${shown.ms} ms, ${shown.opens} opens, ${shown.alerts} link alerts${shown.screens.length ? `; on the way: ${shown.screens.join(' / ')}` : ''}`,
  )
}

/** The screens in each orientation; the share sheet on `/sheets`. */
async function recordScreens(runner, dir) {
  let portrait
  for (const route of SCREENS) {
    const routeDir = path.join(dir, slug(route))
    const shown = await showRoute(runner, route, routeDir, 90_000)
    noteShown('b', route, shown)
    for (const orientation of ORIENTATIONS) {
      const set = await ask(runner, { cmd: 'orientation', set: orientation })
      await sleep(1500)
      const tree = await appTree(runner)
      writeJson(path.join(routeDir, `${orientation}.tree.json`), tree)
      await shots(runner, path.join(routeDir, orientation))
      const root = tree.tree?.frame
      portrait ??= orientation === 'portrait' && root ? root : undefined
      note(
        `  ${orientation}: read back ${set.orientation ?? set.error}; tree ${tree.ok ? `${[...nodesOf(tree.tree)].length} nodes in ${tree.ms} ms, root ${root?.width} × ${root?.height}, marker ${find(tree.tree, (node) => matches(node, MARKERS[route])) ? 'yes' : 'no'}, probe ${probeChannels(tree.tree).join(', ') || 'none'}` : tree.error}`,
      )
    }
    await ask(runner, { cmd: 'orientation', set: 'portrait' })
    await sleep(1500)

    if (route === '/sheets') {
      const opened = await ask(runner, {
        cmd: 'tap',
        app: EXPO_GO_IOS,
        identifier: 'open-share',
      })
      await sleep(2500)
      const sheet = await appTree(runner)
      writeJson(path.join(routeDir, 'share.tree.json'), sheet)
      writeJson(
        path.join(routeDir, 'share.springboard.json'),
        await ask(runner, { cmd: 'tree' }),
      )
      await shots(runner, path.join(routeDir, 'share'))
      const close = find(
        sheet.tree,
        (node) => node.type === 'button' && node.label === 'Close',
      )
      const closed = close
        ? await ask(runner, { cmd: 'tap', app: EXPO_GO_IOS, label: 'Close' })
        : { ok: false, error: 'no "Close" button' }
      await sleep(1500)
      const after = await appTree(runner)
      writeJson(path.join(routeDir, 'share-closed.tree.json'), after)
      note(
        `  share sheet: open ${opened.ok ? 'ok' : opened.error}; ${sheet.ok ? signature(sheet.tree) : sheet.error}; close ${closed.ok ? 'ok' : closed.error}; after: ${after.ok ? (find(after.tree, (node) => matches(node, MARKERS['/sheets'])) ? '/sheets' : signature(after.tree)) : after.error}`,
      )
    }
  }
  return portrait
}

async function statusOf(runner, identifier) {
  const tree = await appTree(runner)
  return textOf(find(tree.tree, (node) => node.identifier === identifier))
}

async function recordTouches(runner, dir) {
  const sheets = await showRoute(runner, '/sheets', path.join(dir, 'sheets'))
  noteShown('b touch', '/sheets', sheets)

  const byElement = await ask(runner, {
    cmd: 'tap',
    app: EXPO_GO_IOS,
    identifier: 'open-alert',
  })
  await sleep(1000)
  const alert = await appTree(runner)
  writeJson(path.join(dir, 'alert.tree.json'), alert)
  const ok = await ask(runner, { cmd: 'tap', app: EXPO_GO_IOS, label: 'OK' })
  await sleep(1000)
  note(
    `b touch by element: Alert ${byElement.ok ? `ok in ${byElement.ms} ms` : byElement.error}; alert in tree: ${find(alert.tree, (node) => node.type === 'alert') ? 'yes' : 'no'}; OK ${ok.ok ? `ok in ${ok.ms} ms` : ok.error}; status "${await statusOf(runner, 'alert')}"`,
  )

  const button = find(sheets.tree, (node) => node.identifier === 'open-alert')
  if (button) {
    const centre = {
      x: button.frame.x + button.frame.width / 2,
      y: button.frame.y + button.frame.height / 2,
    }
    const byPoint = await ask(runner, {
      cmd: 'tap',
      app: EXPO_GO_IOS,
      ...centre,
    })
    await sleep(1000)
    const shown = await appTree(runner)
    const cancel = find(
      shown.tree,
      (node) => node.type === 'button' && node.label === 'Cancel',
    )
    const cancelled = cancel
      ? await ask(runner, {
          cmd: 'tap',
          app: EXPO_GO_IOS,
          x: cancel.frame.x + cancel.frame.width / 2,
          y: cancel.frame.y + cancel.frame.height / 2,
        })
      : { ok: false, error: 'no "Cancel" button' }
    await sleep(1000)
    note(
      `b touch by point (${centre.x}, ${centre.y}): ${byPoint.ok ? 'ok' : byPoint.error}; Cancel ${cancelled.ok ? 'ok' : cancelled.error}; status "${await statusOf(runner, 'alert')}"`,
    )
  }

  const field = await ask(runner, {
    cmd: 'tap',
    app: EXPO_GO_IOS,
    identifier: 'field',
  })
  await sleep(1500)
  const typing = await appTree(runner)
  writeJson(path.join(dir, 'keyboard.tree.json'), typing)
  await shots(runner, path.join(dir, 'keyboard'))
  const typed = await ask(runner, {
    cmd: 'type',
    app: EXPO_GO_IOS,
    text: 'loupe',
  })
  note(
    `b keyboard: field ${field.ok ? 'ok' : field.error}; keyboard in tree: ${find(typing.tree, (node) => node.type === 'keyboard') ? 'yes' : 'no'}; type ${typed.ok ? `ok in ${typed.ms} ms` : typed.error}; field "${await statusOf(runner, 'field')}"`,
  )

  const list = await showRoute(
    runner,
    '/scroll/defect',
    path.join(dir, 'scroll'),
  )
  noteShown('b touch', '/scroll/defect', list)
  const root = list.tree?.frame ?? SCREEN_PT
  const rowBefore = find(list.tree, (node) => node.identifier === 'row-1')
  const dragged = await ask(runner, {
    cmd: 'drag',
    app: EXPO_GO_IOS,
    x: root.width / 2,
    y: root.height * 0.75,
    toX: root.width / 2,
    toY: root.height * 0.35,
    pressMs: 50,
    holdEndMs: 250,
  })
  await sleep(1000)
  const moved = await appTree(runner)
  const rowAfter = find(moved.tree, (node) => node.identifier === 'row-1')
  note(
    `b drag: ${dragged.ok ? `ok in ${dragged.ms} ms` : dragged.error}; row-1 y ${rowBefore?.frame.y} → ${rowAfter?.frame.y ?? 'gone'}`,
  )

  const appState = await showRoute(runner, '/appstate', path.join(dir, 'home'))
  noteShown('b touch', '/appstate', appState)
  const home = await ask(runner, { cmd: 'home' })
  await sleep(2000)
  const away = await ask(runner, { cmd: 'state', app: EXPO_GO_IOS })
  simctl(path.join(dir, 'home', 'launch.txt'), ['launch', udid, EXPO_GO_IOS])
  await sleep(3000)
  const back = await ask(runner, { cmd: 'state', app: EXPO_GO_IOS })
  note(
    `b home: ${home.ok ? 'ok' : home.error}; Expo Go ${away.state ?? away.error}, after simctl launch ${back.state ?? back.error}; states "${await statusOf(runner, 'app-states')}"`,
  )
}

/** Expo Go stopped and opened again; then RTL through app.json and back. */
async function recordExpo(runner, dir) {
  const first = await showRoute(runner, '/appstate', path.join(dir, 'reload-0'))
  let run = textOf(find(first.tree, (node) => node.identifier === 'run'))
  for (const round of [1, 2]) {
    const stop = simctl(path.join(dir, `reload-${round}`, 'terminate.txt'), [
      'terminate',
      udid,
      EXPO_GO_IOS,
    ])
    const shown = await showRoute(
      runner,
      '/appstate',
      path.join(dir, `reload-${round}`),
    )
    const next = textOf(find(shown.tree, (node) => node.identifier === 'run'))
    note(
      `b expo restart ${round}: terminate exit ${stop.status}; ${run} → ${next}; ${shown.tree ? 'route kept' : 'no route'} after ${shown.ms} ms, ${shown.opens} opens, ${shown.alerts} link alerts`,
    )
    run = next
  }

  const appJson = path.join(PROBE_APP, 'app.json')
  const original = readFileSync(appJson, 'utf8')
  const config = JSON.parse(original)
  config.expo.extra = {
    ...config.expo.extra,
    supportsRTL: true,
    forcesRTL: true,
  }
  try {
    for (const [name, text] of [
      ['rtl-on', `${JSON.stringify(config, null, 2)}\n`],
      ['rtl-off', original],
    ]) {
      writeFileSync(appJson, text)
      await sleep(1500)
      simctl(path.join(dir, name, 'terminate.txt'), [
        'terminate',
        udid,
        EXPO_GO_IOS,
      ])
      const shown = await showRoute(
        runner,
        '/probe-channels',
        path.join(dir, name),
      )
      writeJson(path.join(dir, name, 'shown.tree.json'), shown.tree)
      await shots(runner, path.join(dir, name, 'shown'))
      note(
        `b expo ${name}: "${textOf(find(shown.tree, (node) => node.identifier === 'direction'))}" after ${shown.ms} ms, ${shown.opens} opens, ${shown.alerts} link alerts`,
      )
    }
  } finally {
    writeFileSync(appJson, original)
  }
}

async function wayB(runners) {
  const own = runners.find((runner) => runner.xcode === values.xcode)
  if (!own?.xctestrun)
    throw new Error(`No runner build of Xcode ${values.xcode}.`)
  const dir = path.join(out, 'b')
  mkdirSync(dir, { recursive: true })
  const runner = await startRunner({
    xctestrun: own.xctestrun,
    udid,
    port: RUNNER_PORT,
    logFile: path.join(dir, 'xcodebuild.log'),
  })
  if (runner.error) throw new Error(runner.error)
  runner.port = RUNNER_PORT
  note(`b: runner ready after ${runner.ms} ms`)
  try {
    const opened = await showRoute(
      runner,
      '/sheets',
      path.join(dir, 'open'),
      180_000,
    )
    noteShown('b first open', '/sheets', opened)
    const portrait = await part('b screens', () =>
      recordScreens(runner, path.join(dir, 'screens')),
    )
    await part('b touch', () => recordTouches(runner, path.join(dir, 'touch')))
    await part('b expo', () => recordExpo(runner, path.join(dir, 'expo')))
    return portrait
  } finally {
    note(`b: xcodebuild after quit: ${await stopRunner(runner)}`)
  }
}

/** One simtool command: its JSON, and the time of the whole call. */
function simtoolRun(file, args) {
  const start = Date.now()
  const result = captureTool(file, simtool, args, 60_000)
  let answer
  try {
    answer = JSON.parse(result.stdout.toString())
  } catch {
    answer = { error: `no JSON (exit ${result.status})` }
  }
  return { ...answer, wallMs: Date.now() - start }
}

async function wayA(size) {
  const dir = path.join(out, 'a')
  mkdirSync(dir, { recursive: true })
  const title = ['--title', SIMULATOR]
  const sizeArg = ['--size', `${size.width}x${size.height}`]
  let step = 0
  const tool = (name, args) =>
    simtoolRun(
      path.join(dir, `${String(++step).padStart(3, '0')}-${name}.json`),
      args,
    )

  spawnSync('open', ['-a', 'Simulator', '--args', '-CurrentDeviceUDID', udid])
  const start = Date.now()
  let window
  do {
    await sleep(1000)
    window = tool('window', ['window', ...title])
  } while (window.error && Date.now() - start < 90_000)
  note(
    `a: window after ${Date.now() - start} ms: ${window.error ?? `screen ${JSON.stringify(window.screen)}, frontmost ${window.frontmost}`}`,
  )
  if (window.error) throw new Error(window.error)
  const activated = tool('activate', ['activate'])
  note(`a: activate: frontmost ${activated.frontmost} after ${activated.ms} ms`)

  const tree = (name) => {
    const read = tool(`${name}-tree`, ['tree', ...title])
    return read
  }
  const toPoint = (frame, screen) => ({
    x: ((frame.x + frame.width / 2 - screen.x) * size.width) / screen.width,
    y: ((frame.y + frame.height / 2 - screen.y) * size.height) / screen.height,
  })
  const turn = async (key) => {
    tool('activate', ['activate'])
    const turned = tool(`key-${key}`, ['key', key])
    await sleep(2000)
    return turned
  }
  const tapAt = (name, frame, screen) => {
    tool('activate', ['activate'])
    const point = toPoint(frame, screen)
    return tool(name, [
      'tap',
      String(point.x),
      String(point.y),
      ...sizeArg,
      ...title,
    ])
  }
  /**
   * Opens the link in portrait, then reads the tree every 2 s until the
   * route's marker shows: the alert that asks before the link opens gets a
   * tap on "Open" by HID event, and a screen of Expo Go its first closer.
   */
  const show = async (route, file, limit = 60_000) => {
    const opened = openLink(route, file)
    const start = Date.now()
    const isButton = (node) => node.role === 'AXButton'
    let alerts = 0
    let shows = false
    while (!shows && Date.now() - start < limit) {
      await sleep(2000)
      const read = tree(`${slug(route)}-open`)
      shows = Boolean(find(read.tree, (node) => matches(node, MARKERS[route])))
      const open = linkAlertButton(read.tree, isButton)
      const closer =
        !open &&
        !isAppScreen(read.tree) &&
        find(
          read.tree,
          (node) => isButton(node) && CLOSERS.includes(node.label),
        )
      if (open?.frame) {
        alerts++
        tapAt('link-alert-open', open.frame, read.screen)
      } else if (closer?.frame) {
        tapAt(`close-${closer.label}`, closer.frame, read.screen)
      }
    }
    note(
      `a open ${route}: link ${opened.stopped ? 'stopped after 8 s' : `exit ${opened.status}`}; ${shows ? 'shows' : "doesn't show"} after ${Date.now() - start} ms, ${alerts} link alerts`,
    )
  }
  const state = (name) => {
    const read = tool(`${name}-window`, ['window', ...title])
    captureTool(
      path.join(dir, `${String(step).padStart(3, '0')}-${name}-prefs.plist`),
      'defaults',
      ['export', 'com.apple.iphonesimulator', '-'],
    )
    return read
  }

  for (const route of SCREENS) {
    const routeDir = path.join(dir, 'screens', slug(route))
    await show(route, path.join(routeDir, 'openurl.txt'))
    for (const [name, keys] of [
      ['portrait', []],
      ['rotate-left', ['cmd+left']],
      ['rotate-right', ['cmd+right', 'cmd+right']],
    ]) {
      const keyed = []
      for (const key of keys) keyed.push(await turn(key))
      const shape = state(`${slug(route)}-${name}`)
      const read = tree(`${slug(route)}-${name}`)
      simctlShot(path.join(routeDir, name))
      note(
        `a ${route} ${name}: keys ${keyed.map((key) => key.error ?? 'ok').join(', ') || '-'}; screen ${shape.screen?.width} × ${shape.screen?.height}; tree ${read.error ?? `${read.nodes} nodes in ${read.ms} ms, marker ${find(read.tree, (node) => matches(node, MARKERS[route])) ? 'yes' : 'no'}, probe ${probeChannels(read.tree).join(', ') || 'none'}`}`,
      )
    }
    await turn('cmd+left')
  }

  const menuLeft = tool('menu-left', ['menu', 'Device', 'Rotate Left'])
  await sleep(2000)
  const afterMenu = state('menu-left')
  const menuRight = tool('menu-right', ['menu', 'Device', 'Rotate Right'])
  await sleep(2000)
  const backMenu = state('menu-right')
  note(
    `a menu: Rotate Left ${menuLeft.error ?? 'ok'} (screen ${afterMenu.screen?.width} × ${afterMenu.screen?.height}); Rotate Right ${menuRight.error ?? 'ok'} (screen ${backMenu.screen?.width} × ${backMenu.screen?.height})`,
  )

  await show('/sheets', path.join(dir, 'touch', 'openurl.txt'))
  const alertButton = (read) =>
    find(read.tree, (node) => node.identifier === 'open-alert') ??
    find(read.tree, (node) => matches(node, { text: 'Alert' }))
  const okButton = (read) =>
    find(
      read.tree,
      (node) => node.role === 'AXButton' && matches(node, { text: 'OK' }),
    )
  const tapAlert = async (name, via, prepare) => {
    await prepare?.()
    const read = tree(`${name}-before`)
    const button = alertButton(read)
    if (!button?.frame) {
      note(`a tap ${name}: no Alert button in the tree`)
      return
    }
    const point = toPoint(button.frame, read.screen)
    const tapped = tool(`${name}-tap`, [
      'tap',
      String(point.x),
      String(point.y),
      ...sizeArg,
      '--via',
      via,
      ...title,
    ])
    await sleep(1500)
    const shown = tree(`${name}-after`)
    const ok = okButton(shown)
    let closed = 'no OK button'
    if (ok?.frame) {
      tool('activate', ['activate'])
      const okPoint = toPoint(ok.frame, shown.screen)
      const okTap = tool(`${name}-ok`, [
        'tap',
        String(okPoint.x),
        String(okPoint.y),
        ...sizeArg,
        ...title,
      ])
      closed = okTap.error ?? 'ok'
      await sleep(1500)
    }
    note(
      `a tap ${name} (${via}): ${tapped.error ?? 'sent'}; frontmost ${tapped.frontmost}; pointer ${JSON.stringify(tapped.pointer)}; alert ${ok ? 'shown' : 'not shown'}; OK ${closed}`,
    )
  }

  await tapAlert('hid', 'hid', () => tool('activate', ['activate']))
  await tapAlert('pid', 'pid', () => tool('activate', ['activate']))
  await tapAlert('pid-behind', 'pid', async () => {
    spawnSync('open', ['-a', 'Finder'])
    await sleep(1500)
  })
  await tapAlert('after-turn', 'hid', async () => {
    await turn('cmd+left')
    tool('activate', ['activate'])
    tool('key-cmd+right', ['key', 'cmd+right'])
  })

  await show('/scroll/defect', path.join(dir, 'drag', 'openurl.txt'))
  const before = tree('drag-before')
  const row = (read) =>
    find(read.tree, (node) => node.identifier === 'row-1') ??
    find(read.tree, (node) => matches(node, { text: 'Row 1' }))
  tool('activate', ['activate'])
  const dragged = tool('drag', [
    'drag',
    String(size.width / 2),
    String(size.height * 0.75),
    String(size.width / 2),
    String(size.height * 0.35),
    ...sizeArg,
    '--ms',
    '300',
    '--steps',
    '20',
    '--hold-end',
    '250',
    ...title,
  ])
  await sleep(1500)
  const after = tree('drag-after')
  note(
    `a drag: ${dragged.error ?? 'sent'}; row-1 y ${row(before)?.frame?.y} → ${row(after)?.frame?.y ?? 'gone'} (screen coordinates)`,
  )
}

mkdirSync(out, { recursive: true })
let metro
try {
  const list = recordHost()
  const runners = findRunners()
  if (runners.length === 0) throw new Error(`No runner build in ${build}.`)
  udid = bootSimulator(list)
  simctlShot(path.join(out, 'simulator', 'screenshot'))

  let started = 0
  for (const [index, runner] of runners.entries()) {
    if (await startOnce(runner, FIRST_PORT + index)) started++
  }
  if (started === 0) {
    note('No runner started.')
    process.exitCode = 1
  }

  if (!values['build-only']) {
    await recordExpoGo()
    metro = startMetro(path.join(out, 'metro.log'))
    note(`Metro: warm for iOS in ${await warmMetro(metro, 'ios')} ms`)
    const portrait = await part('b', () => wayB(runners))
    await part('a', () => wayA(portrait ?? SCREEN_PT))
  }
} finally {
  if (metro) await stopMetro(metro)
  if (udid) {
    spawnSync('killall', ['Simulator'])
    simctl(path.join(out, 'simulator', 'shutdown.txt'), ['shutdown', udid])
    simctl(path.join(out, 'simulator', 'delete.txt'), ['delete', udid])
  }
  writeFileSync(path.join(out, 'summary.txt'), `${summary.join('\n')}\n`)
}
