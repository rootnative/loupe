// Checks the files that each published package would ship. It packs each one
// with `npm pack --dry-run --ignore-scripts`, so it builds nothing and
// publishes nothing: run it after the build. Each entry point of
// package.json (main, types, bin, exports), each must-have file, and no other
// file may be in the package.
//
// With --ios-runner, the package of loupe must also hold the XCTest runner
// for the iOS simulator in `dist/ios-runner`, with the executable bits on
// its programs. A release gives the flag: only a macOS job can build the
// runner, so a build on another system has none. A test framework of Xcode
// is never in a package.
//
// Usage: node scripts/check-pack.mjs [repository root] [--ios-runner]

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  RUNNER_BINARIES,
  RUNNER_DIR,
  RUNNER_FILES,
  XCODE_FRAMEWORK,
} from './lib/ios-runner.mjs'

const args = process.argv.slice(2)
const withRunner = args.includes('--ios-runner')
const root = path.resolve(args.find((arg) => !arg.startsWith('--')) ?? '.')
const inRunner = (file) => `${RUNNER_DIR}/${file}`

const PACKAGES = [
  {
    dir: 'packages/loupe',
    must: [
      'README.md',
      'CHANGELOG.md',
      'LICENSE',
      'skills/loupe/SKILL.md',
      ...(withRunner ? RUNNER_FILES.map(inRunner) : []),
    ],
    may: [/^dist\//, /^skills\/loupe\//],
    executable: withRunner ? RUNNER_BINARIES.map(inRunner) : [],
  },
  {
    dir: 'packages/probe',
    must: ['README.md', 'CHANGELOG.md', 'LICENSE'],
    may: [/^dist\//],
    executable: [],
  },
]

// Never in a package, also inside an allowed folder.
const NEVER =
  /(^|\/)(src|test|tests|fixtures|node_modules|\.turbo)\/|\.test\.|\.map$/

/** Each file path that package.json names as an entry point. */
function entryPoints(manifest) {
  const paths = []
  const add = (value) => {
    if (typeof value === 'string') paths.push(value)
    else if (value && typeof value === 'object') {
      for (const [key, inner] of Object.entries(value)) {
        if (key !== './package.json') add(inner)
      }
    }
  }
  add(manifest.main)
  add(manifest.types)
  add(manifest.bin)
  add(manifest.exports)
  return [...new Set(paths.map((file) => path.posix.normalize(file)))]
}

function pack(dir) {
  const result = spawnSync(
    'npm',
    ['pack', '--dry-run', '--json', '--ignore-scripts'],
    { cwd: dir, encoding: 'utf8', shell: process.platform === 'win32' },
  )
  if (result.status !== 0) {
    throw new Error(`npm pack failed in ${dir}: ${result.stderr.trim()}`)
  }
  const [packed] = JSON.parse(result.stdout)
  return packed
}

let problems = 0
const problem = (text) => {
  console.log(`  FAIL: ${text}`)
  problems += 1
}

for (const { dir, must, may, executable } of PACKAGES) {
  const folder = path.join(root, dir)
  const manifest = JSON.parse(
    readFileSync(path.join(folder, 'package.json'), 'utf8'),
  )
  const packed = pack(folder)
  const files = new Set(packed.files.map((file) => file.path))
  console.log(
    `${manifest.name}@${manifest.version}: ${files.size} files, ${Math.round(packed.unpackedSize / 1000)} kB unpacked`,
  )

  for (const file of [...entryPoints(manifest), ...must]) {
    if (!files.has(file)) problem(`${file} isn't in the package.`)
  }
  for (const file of files) {
    const allowed =
      file === 'package.json' ||
      must.includes(file) ||
      may.some((pattern) => pattern.test(file))
    if (!allowed || NEVER.test(file) || XCODE_FRAMEWORK.test(file)) {
      problem(`${file} is in the package, but it must not be.`)
    }
  }
  for (const { path: file, mode } of packed.files) {
    if (executable.includes(file) && (mode & 0o111) === 0) {
      problem(`${file} has no executable bit in the package.`)
    }
  }
}

if (problems > 0) {
  console.log(`${problems} problems. Check "files" in each package.json.`)
  process.exit(1)
}
console.log('Each package has its entry points and its files, and no other.')
