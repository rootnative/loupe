// Checks the XCTest runner for the iOS simulator, as the package ships it:
// each file of the runner is there, each Mach-O file has an arm64 and an
// x86_64 slice, each program has its executable bits, and no test framework
// of Xcode is in it. It reads the files only, so it runs on each system.
//
// With --start (macOS with Xcode only), it then makes a new simulator,
// starts the runner on it with `xcodebuild test-without-building`, asks for
// `ping` and the tree of Springboard, and stops it. DEVELOPER_DIR picks the
// Xcode. The "iOS runner" job of CI runs it this way.
//
// Usage: node scripts/check-ios-runner.mjs <runner dir>
//          [--start --ios <version> --device <name>]

import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import {
  RUNNER_BINARIES,
  RUNNER_FILES,
  XCODE_FRAMEWORK,
  XCTESTRUN,
} from './lib/ios-runner.mjs'
import { iosRuntime, startRunner, stopRunner, toolText } from './lib/ios.mjs'

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    start: { type: 'boolean', default: false },
    ios: { type: 'string' },
    device: { type: 'string' },
  },
})
const [folder] = positionals
if (!folder || (values.start && (!values.ios || !values.device))) {
  throw new Error(
    'Usage: node scripts/check-ios-runner.mjs <runner dir> [--start --ios <version> --device <name>]',
  )
}
const dir = path.resolve(folder)

const FAT_MAGIC = 0xcafebabe
// A Mach-O file with one slice, 64-bit, as each byte order writes it.
const THIN_MAGICS = [0xfeedfacf, 0xcffaedfe]
const CPU = { 0x01000007: 'x86_64', 0x0100000c: 'arm64' }
const SLICES = ['arm64', 'x86_64']
const PORT = 22087

let problems = 0
const problem = (text) => {
  console.log(`  FAIL: ${text}`)
  problems += 1
}

function filesOf(base, below = '') {
  return readdirSync(path.join(base, below), { withFileTypes: true }).flatMap(
    (entry) => {
      const file = path.posix.join(below, entry.name)
      return entry.isDirectory() ? filesOf(base, file) : [file]
    },
  )
}

/** The slices of a Mach-O file; undefined for a file of another kind. */
function slicesOf(bytes) {
  if (bytes.length < 8) return undefined
  const magic = bytes.readUInt32BE(0)
  if (THIN_MAGICS.includes(magic)) return ['one slice only']
  if (magic !== FAT_MAGIC) return undefined
  const count = bytes.readUInt32BE(4)
  return Array.from({ length: count }, (_, index) => {
    const cpu = bytes.readUInt32BE(8 + index * 20)
    return CPU[cpu] ?? `cpu ${cpu.toString(16)}`
  })
}

const files = filesOf(dir)
console.log(`${dir}: ${files.length} files`)

for (const file of RUNNER_FILES) {
  if (!files.includes(file)) problem(`${file} isn't in the runner.`)
}
for (const file of files) {
  if (XCODE_FRAMEWORK.test(file)) {
    problem(`${file} is a test framework of Xcode. The package ships none.`)
    continue
  }
  const full = path.join(dir, file)
  const slices = slicesOf(readFileSync(full))
  const program = RUNNER_BINARIES.includes(file)
  if (program && !slices) problem(`${file} isn't a Mach-O file.`)
  if (slices) {
    console.log(`  ${file}: ${slices.join(' ')}`)
    for (const slice of SLICES) {
      if (!slices.includes(slice)) problem(`${file} has no ${slice} slice.`)
    }
  }
  if (program && (statSync(full).mode & 0o111) === 0) {
    problem(`${file} has no executable bit.`)
  }
}
// A path of the machine that built the runner works on no other machine.
if (
  files.includes(XCTESTRUN) &&
  /\/(Users|private|var)\//.test(
    readFileSync(path.join(dir, XCTESTRUN), 'utf8'),
  )
) {
  problem(`${XCTESTRUN} holds an absolute path of the build machine.`)
}

async function start() {
  const list = JSON.parse(toolText('xcrun', ['simctl', 'list', '--json']))
  const runtime = iosRuntime(list, values.ios)
  if (!runtime) throw new Error(`No available iOS ${values.ios} runtime.`)
  const udid = toolText('xcrun', [
    'simctl',
    'create',
    'loupe-runner-check',
    values.device,
    runtime.identifier,
  ]).trim()
  if (!udid) throw new Error('simctl create failed.')
  const log = path.join(tmpdir(), 'loupe-runner-check.log')
  let runner
  try {
    spawnSync('xcrun', ['simctl', 'boot', udid])
    const booted = spawnSync('xcrun', ['simctl', 'bootstatus', udid, '-b'], {
      timeout: 600_000,
    })
    if (booted.status !== 0) throw new Error("The simulator didn't boot.")

    runner = await startRunner({
      xctestrun: path.join(dir, XCTESTRUN),
      udid,
      port: PORT,
      logFile: log,
    })
    if (runner.error) throw new Error(runner.error)
    console.log(
      `The runner answered after ${runner.ms} ms: built with ${runner.ping.builtWith}, on ${runner.ping.os} (${values.device}, ${runtime.name}).`,
    )
    const tree = await runner.client.request({ cmd: 'tree' }, 60_000)
    if (!tree.ok) throw new Error(`No tree of Springboard: ${tree.error}`)
    console.log(`The tree of Springboard came in ${tree.ms} ms.`)
    const exit = await stopRunner(runner)
    runner = undefined
    if (exit !== 0) throw new Error(`xcodebuild ended with ${exit}.`)
  } catch (error) {
    console.log(`--- the end of ${log}`)
    console.log(toolText('tail', ['-60', log]))
    throw error
  } finally {
    if (runner) await stopRunner(runner)
    spawnSync('xcrun', ['simctl', 'shutdown', udid])
    spawnSync('xcrun', ['simctl', 'delete', udid])
  }
}

if (problems === 0 && values.start) {
  try {
    await start()
  } catch (error) {
    problem(error instanceof Error ? error.message : String(error))
  }
}

if (problems > 0) {
  console.log(`${problems} problems in the iOS runner.`)
  process.exit(1)
}
console.log(
  values.start
    ? 'The iOS runner has its files and both slices, ships no framework of Xcode, and starts.'
    : 'The iOS runner has its files and both slices, and ships no framework of Xcode.',
)
