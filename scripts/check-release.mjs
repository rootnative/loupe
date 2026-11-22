// Checks that publishing this version now, to this dist-tag, is what was
// meant. The gates check the tree; this script checks the release. The
// release workflow runs it after the version bump.
//
//   node scripts/check-release.mjs --version 0.0.0-alpha.1 --dist-tag latest [--dry-run]
//
// - npm is new enough for `npm stage publish` with trusted publishing.
// - The version is x.y.z or x.y.z-alpha.N, and both packages have it.
// - Each CHANGELOG has a dated section and a link for it. With --dry-run, a
//   missing section is a warning, so a dry run can come before the notes.
// - The tag loupe@<version> doesn't exist yet. A CI checkout needs
//   `fetch-depth: 0` for this.
// - A prerelease on `latest` doesn't replace a stable release there.

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const PACKAGES = ['packages/loupe', 'packages/probe']
const REPOSITORY = 'https://github.com/rootnative/loupe'
const MINIMUM_NPM = '11.15.0'

const argument = (name) => {
  const at = process.argv.indexOf(`--${name}`)
  return at === -1 ? undefined : process.argv[at + 1]
}
const requested = argument('version')
const distTag = argument('dist-tag')
const dryRun = process.argv.includes('--dry-run')
if (requested === undefined || distTag === undefined) {
  console.error(
    'Usage: node scripts/check-release.mjs --version <x.y.z> --dist-tag <tag> [--dry-run]',
  )
  process.exit(2)
}

const problems = []
const warnings = []

const coreNumbers = (version) => version.split('-')[0].split('.').map(Number)
const compareCore = (a, b) => {
  const left = coreNumbers(a)
  const right = coreNumbers(b)
  for (let i = 0; i < 3; i += 1) {
    const difference = (left[i] ?? 0) - (right[i] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const read = (file) => readFileSync(join(root, file), 'utf8')

// An older npm doesn't try trusted publishing: it finds no token and fails
// with a 404 that names neither cause.
const npmVersion = execFileSync('npm', ['--version'], {
  encoding: 'utf8',
}).trim()
if (compareCore(npmVersion, MINIMUM_NPM) < 0) {
  problems.push(
    `npm ${npmVersion} can't stage a publish with trusted publishing. Pin npm ${MINIMUM_NPM} or later in release-manual.yml.`,
  )
}

if (!/^\d+\.\d+\.\d+(-alpha\.\d+)?$/.test(requested)) {
  problems.push(
    `${requested} isn't a loupe version: give x.y.z, or x.y.z-alpha.N before the first stable release.`,
  )
}

const tag = `loupe@${requested}`
const section = new RegExp(
  `^## \\[${escape(requested)}\\] - \\d{4}-\\d{2}-\\d{2}$`,
  'm',
)
const link = new RegExp(
  `^\\[${escape(requested)}\\]: ${escape(`${REPOSITORY}/releases/tag/${tag}`)}$`,
  'm',
)

let packageName
for (const dir of PACKAGES) {
  const manifest = JSON.parse(read(`${dir}/package.json`))
  packageName ??= manifest.name
  if (manifest.version !== requested) {
    problems.push(
      `You asked for ${requested}, but ${dir}/package.json has ${manifest.version}.`,
    )
  }
  if (manifest.private === true) {
    problems.push(`${dir}/package.json is private, so npm won't publish it.`)
  }

  // Git on Windows checks out text files with CRLF line ends.
  const changelog = read(`${dir}/CHANGELOG.md`).replace(/\r\n/g, '\n')
  const notes = dryRun ? warnings : problems
  if (!section.test(changelog)) {
    notes.push(
      `${dir}/CHANGELOG.md has no "## [${requested}] - <date>" section. Both packages ship in this release, so write the note of each one.`,
    )
  }
  if (!link.test(changelog)) {
    notes.push(
      `${dir}/CHANGELOG.md has no link "[${requested}]: ${REPOSITORY}/releases/tag/${tag}".`,
    )
  }
  if (!/^## \[Unreleased\]$/m.test(changelog)) {
    problems.push(
      `${dir}/CHANGELOG.md has no "## [Unreleased]" section. Keep it above the version.`,
    )
  }
}

let tagExists = true
try {
  execFileSync('git', ['rev-parse', '-q', '--verify', `refs/tags/${tag}`], {
    cwd: root,
    stdio: 'ignore',
  })
} catch {
  tagExists = false
}
if (tagExists) {
  problems.push(
    `The tag ${tag} exists. If ${requested} is on npm, give a new version: npm never takes a version twice. ` +
      `If it isn't, an earlier run pushed the tag and then failed to publish. Delete the tag and run again: ` +
      `git push --delete origin ${tag} && git tag -d ${tag}`,
  )
}

// `null`: the package has no `latest` yet. `undefined`: the lookup failed.
const latestOnRegistry = () => {
  try {
    const output = execFileSync(
      'npm',
      ['view', packageName, 'dist-tags.latest'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim()
    return output === '' ? null : output
  } catch (error) {
    return /E404|404 Not Found/.test(
      `${error.stderr ?? ''}${error.message ?? ''}`,
    )
      ? null
      : undefined
  }
}

// `npm install` takes `latest`. While no stable version exists, the alphas
// go there. A prerelease must not replace a stable release as the default.
const prerelease = requested.includes('-')
if (prerelease && distTag === 'latest') {
  const latest = latestOnRegistry()
  if (latest === undefined) {
    problems.push(
      `${requested} is a prerelease for \`latest\`, and the registry lookup failed, so this can't tell if it replaces a stable release. Check the network, or pick alpha.`,
    )
  } else if (latest !== null && !latest.includes('-')) {
    problems.push(
      `${requested} is a prerelease and would replace the stable ${latest} on \`latest\`. Pick alpha.`,
    )
  }
}
if (!prerelease && distTag !== 'latest') {
  warnings.push(
    `${requested} is stable but goes to \`${distTag}\`, so \`npm install ${packageName}\` won't install it.`,
  )
}

const inActions = process.env.GITHUB_ACTIONS === 'true'
for (const message of warnings) {
  console.error(`${inActions ? '::warning::' : 'Warning: '}${message}`)
}
for (const message of problems) {
  console.error(`${inActions ? '::error::' : 'Error: '}${message}`)
}

if (problems.length > 0) process.exit(1)
console.log(
  `Ready to release ${requested} as ${tag} on \`${distTag}\`, with npm ${npmVersion}.`,
)
