// Runs the built loupe CLI on a new iOS simulator, and checks each result.
// The "iOS runner" job of the CI workflow runs it after the build of the
// package and of the runner. It reads the JSON on a pipe, as an agent does.
//
// It puts the runner into packages/loupe/dist/ios-runner, as a release
// does, so the CLI finds and starts the runner that the package ships. It
// checks: `devices` lists the simulator; the first `screenshot` starts the
// runner and keeps its record; the second one uses that runner; the runner
// takes no request with no token; a screenshot in landscape is upright; a
// command with no iOS part gives `unsupported`.
//
// Run it on macOS with Xcode, after `pnpm install` and the build.
// DEVELOPER_DIR picks the Xcode.
//
// Usage: node scripts/ios-smoke.mjs <out-dir> --runner <runner dir>
//          --ios <version> --device <name>

import { spawnSync } from 'node:child_process'
import {
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { connect } from 'node:net'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { parseArgs } from 'node:util'
import { RUNNER_DIR } from './lib/ios-runner.mjs'
import { iosRuntime, toolText } from './lib/ios.mjs'

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    runner: { type: 'string' },
    ios: { type: 'string' },
    device: { type: 'string' },
  },
})
const [outArg] = positionals
if (!outArg || !values.runner || !values.ios || !values.device) {
  throw new Error(
    'Usage: node scripts/ios-smoke.mjs <out-dir> --runner <runner dir> --ios <version> --device <name>',
  )
}

const out = path.resolve(outArg)
const state = path.join(out, 'state')
const BIN = path.resolve('packages/loupe/dist/bin.js')
const SIMULATOR = 'loupe-ios-smoke'
mkdirSync(out, { recursive: true })

function check(what, passed, detail = '') {
  console.log(
    `${passed ? 'ok  ' : 'FAIL'} ${what}${detail ? `: ${detail}` : ''}`,
  )
  if (!passed) throw new Error(`${what} failed. ${detail}`)
}

let step = 0
/** One CLI call: its JSON result, and its time in ms. */
function loupe(...args) {
  const start = Date.now()
  const result = spawnSync('node', [BIN, ...args], {
    encoding: 'utf8',
    env: { ...process.env, LOUPE_STATE_DIR: state },
    timeout: 400_000,
    maxBuffer: 64 * 1024 * 1024,
  })
  const ms = Date.now() - start
  const name = `${String(++step).padStart(2, '0')}-${args[0]}`
  writeFileSync(path.join(out, `${name}.json`), result.stdout ?? '')
  if (result.stderr)
    writeFileSync(path.join(out, `${name}.stderr`), result.stderr)
  let json
  try {
    json = JSON.parse(result.stdout)
  } catch {
    throw new Error(`loupe ${args[0]} gave no JSON (exit ${result.status}).`)
  }
  return { ...json, ms }
}

/** One request to the runner with no loupe between, and its answer. */
function ask(port, message) {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port })
    let buffer = ''
    socket.setEncoding('utf8')
    socket.setTimeout(30_000, () => socket.destroy(new Error('No answer.')))
    socket.once('error', reject)
    socket.on('data', (chunk) => {
      buffer += chunk
      const end = buffer.indexOf('\n')
      if (end >= 0) {
        socket.destroy()
        resolve(JSON.parse(buffer.slice(0, end)))
      }
    })
    socket.once('connect', () => socket.write(`${JSON.stringify(message)}\n`))
  })
}

function pngSize(file) {
  const bytes = readFileSync(file)
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

const sameSize = (a, b) => a.width === b.width && a.height === b.height

// The package of a release has the runner here.
const packaged = path.resolve('packages/loupe', RUNNER_DIR)
rmSync(packaged, { recursive: true, force: true })
mkdirSync(path.dirname(packaged), { recursive: true })
spawnSync('cp', ['-R', path.resolve(values.runner), packaged])

const list = JSON.parse(toolText('xcrun', ['simctl', 'list', '--json']))
const runtime = iosRuntime(list, values.ios)
if (!runtime) throw new Error(`No available iOS ${values.ios} runtime.`)
const udid = toolText('xcrun', [
  'simctl',
  'create',
  SIMULATOR,
  values.device,
  runtime.identifier,
]).trim()
if (!udid) throw new Error('simctl create failed.')

let record
try {
  spawnSync('xcrun', ['simctl', 'boot', udid])
  const booted = spawnSync('xcrun', ['simctl', 'bootstatus', udid, '-b'], {
    timeout: 600_000,
  })
  check(
    'the simulator boots',
    booted.status === 0,
    `${values.device}, ${runtime.name}`,
  )

  const devices = loupe('devices')
  const listed = devices.data?.devices.find((device) => device.udid === udid)
  check(
    'devices lists the simulator as ready',
    devices.ok && listed?.state === 'ready' && listed.platform === 'ios',
    JSON.stringify(listed),
  )

  const portraitFile = path.join(out, 'portrait.png')
  const first = loupe('screenshot', portraitFile, '--device', udid)
  check(
    'the first screenshot starts the runner',
    first.ok,
    first.ok ? `${first.ms} ms` : JSON.stringify(first.error),
  )
  const { data: portrait } = first
  check(
    'the screen is in portrait, with its size in pt',
    portrait.orientation === 'portrait' &&
      portrait.scale > 1 &&
      Math.abs(portrait.size.width * portrait.scale - portrait.pixels.width) <
        1 &&
      portrait.pixels.height > portrait.pixels.width,
    `${portrait.size.width} × ${portrait.size.height} pt, ${portrait.pixels.width} × ${portrait.pixels.height} px, scale ${portrait.scale}`,
  )
  check(
    'the PNG file has the size of the screen',
    sameSize(pngSize(portraitFile), portrait.pixels),
  )

  const recordFile = path.join(state, `runner-${udid}.json`)
  record = JSON.parse(readFileSync(recordFile, 'utf8'))
  check(
    'the record has the port and the token, and only the user reads it',
    record.port > 0 &&
      /^[0-9a-f]{32}$/.test(record.token) &&
      (statSync(recordFile).mode & 0o077) === 0,
    `port ${record.port}, pid ${record.pid}, loupe ${record.version}`,
  )

  const second = loupe(
    'screenshot',
    path.join(out, 'again.png'),
    '--device',
    udid,
  )
  const after = JSON.parse(readFileSync(recordFile, 'utf8'))
  check(
    'the second screenshot uses the same runner',
    second.ok && after.pid === record.pid && after.port === record.port,
    `${second.ms} ms (the first: ${first.ms} ms)`,
  )

  const noToken = await ask(record.port, { id: 1, cmd: 'ping' })
  const wrongToken = await ask(record.port, { id: 1, cmd: 'ping', token: 'x' })
  check(
    'the runner takes no request with no token, or with a wrong one',
    noToken.ok === false && wrongToken.ok === false,
    noToken.error,
  )

  const turned = await ask(record.port, {
    id: 1,
    cmd: 'orientation',
    set: 'landscapeLeft',
    token: record.token,
  })
  await sleep(2000)
  const landscapeFile = path.join(out, 'landscape-left.png')
  const {
    ok,
    data: landscape,
    error,
  } = loupe('screenshot', landscapeFile, '--device', udid)
  check(
    'a screenshot in landscape is upright',
    ok &&
      turned.orientation === 'landscapeLeft' &&
      landscape.orientation === 'landscape-left' &&
      landscape.pixels.width === portrait.pixels.height &&
      landscape.pixels.height === portrait.pixels.width &&
      sameSize(pngSize(landscapeFile), landscape.pixels),
    ok
      ? `${landscape.pixels.width} × ${landscape.pixels.height} px`
      : JSON.stringify(error),
  )
  await ask(record.port, {
    id: 1,
    cmd: 'orientation',
    set: 'portrait',
    token: record.token,
  })

  const ui = loupe('ui', '--device', udid)
  check(
    'a command with no iOS part gives unsupported',
    ui.ok === false && ui.error.code === 'unsupported',
    ui.error?.code,
  )

  const quit = await ask(record.port, {
    id: 1,
    cmd: 'quit',
    token: record.token,
  })
  check('the runner stops on quit', quit.ok === true)
  console.log('All checks passed.')
} finally {
  if (record) {
    await ask(record.port, { id: 1, cmd: 'quit', token: record.token }).catch(
      () => undefined,
    )
  }
  spawnSync('xcrun', ['simctl', 'shutdown', udid])
  spawnSync('xcrun', ['simctl', 'delete', udid])
}
