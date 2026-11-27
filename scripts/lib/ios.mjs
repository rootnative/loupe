// Shared by the scripts that drive an iOS simulator in CI: simctl with its
// raw output kept, and the client of the XCTest runner in packages/loupe/native/ios.
// Run them from the root of the repository on a macOS runner. DEVELOPER_DIR
// picks the Xcode of each call.

import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, openSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { probeAppSdk } from './expo-go.mjs'

export const EXPO_GO_IOS = 'host.exp.Exponent'

// A tree or a screenshot in base64 passes 1 MB, the default of spawnSync.
const MAX_BUFFER = 64 * 1024 * 1024

/**
 * Runs one tool and saves its output, as the Android recorders do: stdout in
 * `file`, stderr in `<file>.stderr` and a non-zero exit code in
 * `<file>.exit`. Gives the result of `spawnSync`.
 */
export function captureTool(file, command, args, timeout = 120_000) {
  const result = spawnSync(command, args, { timeout, maxBuffer: MAX_BUFFER })
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, result.stdout ?? Buffer.alloc(0))
  if (result.stderr?.length) writeFileSync(`${file}.stderr`, result.stderr)
  if (result.status !== 0) {
    writeFileSync(`${file}.exit`, `${result.status ?? result.error}\n`)
  }
  return result
}

/** Runs one tool, and gives its stdout as text ('' when it fails). */
export function toolText(command, args, timeout = 120_000) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout,
    maxBuffer: MAX_BUFFER,
  })
  return result.status === 0 ? result.stdout : ''
}

/** `xcrun simctl <args>`, with its output kept in `file`. */
export function simctl(file, args, timeout) {
  return captureTool(file, 'xcrun', ['simctl', ...args], timeout)
}

/**
 * The available iOS runtime of `simctl list --json` whose version is
 * `version` or starts with it (`26.0` matches `26.0.1`).
 */
export function iosRuntime(list, version) {
  return list.runtimes.find(
    (runtime) =>
      runtime.isAvailable &&
      runtime.platform === 'iOS' &&
      (runtime.version === version ||
        runtime.version.startsWith(`${version}.`)),
  )
}

/**
 * Installs Expo Go for the probe app's SDK on the simulator `udid`, from the
 * versions list that the Expo CLI reads too. The archive holds the files of
 * the app, not its folder. The output of simctl goes to `dir`. Gives the
 * SDK, the URL, Expo Go's version, its CPU slices and the time in ms.
 */
export async function installExpoGoIos(udid, dir) {
  const start = Date.now()
  const sdk = probeAppSdk()
  const list = await fetch('https://api.expo.dev/v2/versions/latest')
  const url = (await list.json()).data?.sdkVersions?.[sdk]?.iosClientUrl
  if (!url) {
    throw new Error(`The Expo versions list has no iOS Expo Go for SDK ${sdk}.`)
  }
  const download = await fetch(url)
  if (!download.ok) {
    throw new Error(`Expo Go didn't download: HTTP ${download.status}.`)
  }
  const folder = mkdtempSync(path.join(tmpdir(), 'expo-go-ios-'))
  const archive = path.join(folder, 'expo-go.tar.gz')
  writeFileSync(archive, Buffer.from(await download.arrayBuffer()))
  const app = path.join(folder, 'Exponent.app')
  mkdirSync(app)
  const unpacked = spawnSync('tar', ['-xzf', archive, '-C', app], {
    encoding: 'utf8',
  })
  if (unpacked.status !== 0) {
    throw new Error(`Expo Go didn't unpack: ${unpacked.stderr}`)
  }

  const plist = path.join(app, 'Info.plist')
  const field = (key) =>
    toolText('plutil', ['-extract', key, 'raw', plist]).trim()
  const archs = toolText('lipo', [
    '-archs',
    path.join(app, field('CFBundleExecutable')),
  ]).trim()
  const install = simctl(
    path.join(dir, 'install.txt'),
    ['install', udid, app],
    300_000,
  )
  if (install.status !== 0) {
    throw new Error("Expo Go didn't install. See install.txt.")
  }
  return {
    sdk,
    url,
    bundleId: field('CFBundleIdentifier'),
    version: field('CFBundleShortVersionString'),
    archs,
    ms: Date.now() - start,
  }
}

/** Connects to the runner, or gives undefined when nothing listens. */
export function connectRunner(port) {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port })
    socket.once('connect', () => resolve(clientOf(socket)))
    socket.once('error', () => resolve(undefined))
  })
}

/**
 * One request at a time: each answer is the next line. A request with no
 * answer in time closes the connection, so a late answer can't go to the
 * next request.
 */
function clientOf(socket) {
  let buffer = ''
  let waiting
  let nextId = 1
  socket.setEncoding('utf8')
  socket.on('data', (chunk) => {
    buffer += chunk
    for (let end; (end = buffer.indexOf('\n')) >= 0;) {
      const line = buffer.slice(0, end)
      buffer = buffer.slice(end + 1)
      const current = waiting
      waiting = undefined
      current?.resolve(JSON.parse(line))
    }
  })
  const fail = (error) => {
    const current = waiting
    waiting = undefined
    current?.reject(error)
  }
  socket.on('error', fail)
  socket.on('close', () => fail(new Error('The runner closed the connection.')))

  return {
    request(message, limit = 120_000) {
      if (waiting) throw new Error('One request at a time.')
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          socket.destroy()
          fail(new Error(`No answer to ${message.cmd} in ${limit} ms.`))
        }, limit)
        waiting = {
          resolve: (answer) => {
            clearTimeout(timer)
            resolve(answer)
          },
          reject: (error) => {
            clearTimeout(timer)
            reject(error)
          },
        }
        socket.write(`${JSON.stringify({ id: nextId++, ...message })}\n`)
      })
    },
    close() {
      socket.destroy()
    },
  }
}

/**
 * Starts the runner of an `.xctestrun` file on the simulator `udid` with
 * `xcodebuild test-without-building`, and waits until it answers `ping` on
 * 127.0.0.1:`port`. xcodebuild writes to `logFile`. Gives `{ client, ping,
 * ms, xcodebuild }`, or `{ error, ms, xcodebuild }` when the runner doesn't
 * answer within `limit` ms or xcodebuild ends first.
 */
export async function startRunner({
  xctestrun,
  udid,
  port,
  logFile,
  limit = 300_000,
}) {
  const log = openSync(logFile, 'w')
  const start = Date.now()
  const xcodebuild = spawn(
    'xcodebuild',
    [
      'test-without-building',
      '-xctestrun',
      xctestrun,
      '-destination',
      `id=${udid}`,
    ],
    {
      env: { ...process.env, TEST_RUNNER_LOUPE_PORT: String(port) },
      stdio: ['ignore', log, log],
    },
  )
  for (;;) {
    const ms = Date.now() - start
    if (xcodebuild.exitCode !== null) {
      return {
        error: `xcodebuild ended with ${xcodebuild.exitCode} before the runner answered.`,
        ms,
        xcodebuild,
      }
    }
    if (ms > limit) {
      xcodebuild.kill()
      return {
        error: `The runner didn't answer in ${limit} ms.`,
        ms,
        xcodebuild,
      }
    }
    const client = await connectRunner(port)
    if (client) {
      const ping = await client
        .request({ cmd: 'ping' }, 30_000)
        .catch(() => undefined)
      if (ping?.ok) {
        return { client, ping, ms: Date.now() - start, xcodebuild }
      }
      client.close()
    }
    await sleep(1000)
  }
}

/**
 * Sends `quit`, then waits up to 60 s for xcodebuild to end, and stops it
 * after that. Gives xcodebuild's exit code, or the signal.
 */
export async function stopRunner({ client, xcodebuild }) {
  await client?.request({ cmd: 'quit' }, 30_000).catch(() => undefined)
  client?.close()
  if (xcodebuild.exitCode === null && xcodebuild.signalCode === null) {
    const ended = once(xcodebuild, 'exit')
    const late = await Promise.race([
      ended.then(() => false),
      sleep(60_000).then(() => true),
    ])
    if (late) {
      xcodebuild.kill()
      await ended
    }
  }
  return xcodebuild.exitCode ?? xcodebuild.signalCode
}
