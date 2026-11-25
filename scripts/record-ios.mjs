// Recorder round 11: how loupe can drive an iOS simulator, on one macOS
// runner. Run it from the root of the repository after the build steps of
// ios-fixtures.yml, with DEVELOPER_DIR set to the job's Xcode:
//
//   node scripts/record-ios.mjs <out> --ios <version> --device <name> --build <dir>
//
// <dir> holds `simtool` (way A) and one `runner-<xcode>` folder for each
// Xcode that built the runner (way B): the derived data of `xcodebuild
// build-for-testing`. The script keeps the host facts, boots a new simulator
// with no window, and starts each runner on it once. A runner that doesn't
// start is data, not a failure: the script fails only when a part can't
// run, or when no runner starts.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import {
  captureTool,
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
    build: { type: 'string' },
  },
})
const [out] = positionals
if (!out || !values.ios || !values.device || !values.build) {
  throw new Error(
    'Usage: node scripts/record-ios.mjs <out> --ios <version> --device <name> --build <dir>',
  )
}

const build = path.resolve(values.build)
const simtool = path.join(build, 'simtool')
const PRODUCTS = path.join('Build', 'Products')
const RUNNER_APP = path.join('Debug-iphonesimulator', 'LoupeRunner-Runner.app')
const FIRST_PORT = 22087

const summary = []
function note(line) {
  console.log(line)
  summary.push(line)
}

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
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
    'loupe-round-11',
    values.device,
    runtime.identifier,
  ])
  if (created.status !== 0) throw new Error('simctl create failed.')
  const udid = created.stdout.toString().trim()
  note(`simulator: ${values.device}, ${runtime.name}, ${udid}`)

  const start = Date.now()
  simctl(path.join(dir, 'boot.txt'), ['boot', udid])
  const booted = simctl(
    path.join(dir, 'bootstatus.txt'),
    ['bootstatus', udid, '-b'],
    600_000,
  )
  note(`boot: ${Date.now() - start} ms, bootstatus exit ${booted.status}`)
  if (booted.status !== 0) throw new Error("The simulator didn't boot.")
  simctl(path.join(dir, 'screenshot.txt'), [
    'io',
    udid,
    'screenshot',
    path.join(dir, 'screenshot.png'),
  ])
  return udid
}

async function ask(runner, message) {
  return runner.client
    .request(message)
    .catch((error) => ({ ok: false, error: String(error) }))
}

/** Starts one runner build on the simulator, asks a few things, and quits. */
async function startOnce({ xcode, products, xctestrun }, udid, port) {
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
  const shot = await ask(runner, { cmd: 'screenshot' })
  if (shot.ok) {
    writeFileSync(
      path.join(dir, 'screenshot.png'),
      Buffer.from(shot.png, 'base64'),
    )
  }
  note(`  screenshot: ${shot.ok ? 'ok' : shot.error}, ${shot.ms} ms`)

  const exit = await stopRunner(runner)
  note(`  xcodebuild after quit: ${exit}`)
  return true
}

mkdirSync(out, { recursive: true })
let udid
try {
  const list = recordHost()
  const runners = findRunners()
  if (runners.length === 0) throw new Error(`No runner build in ${build}.`)
  udid = bootSimulator(list)

  let started = 0
  for (const [index, runner] of runners.entries()) {
    if (await startOnce(runner, udid, FIRST_PORT + index)) started++
  }
  if (started === 0) {
    note('No runner started.')
    process.exitCode = 1
  }
} finally {
  if (udid) {
    simctl(path.join(out, 'simulator', 'shutdown.txt'), ['shutdown', udid])
    simctl(path.join(out, 'simulator', 'delete.txt'), ['delete', udid])
  }
  writeFileSync(path.join(out, 'summary.txt'), `${summary.join('\n')}\n`)
}
