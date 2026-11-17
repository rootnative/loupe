// Records the layout patterns of the probe app (apps/probe-app/patterns.tsx)
// for the rules of `loupe check`: each pattern as a defect and as its fixed
// twin, in portrait and in both landscapes, with the hole cutout, in LTR and
// in RTL. For each screen it keeps the raw uiautomator dump in which the
// probe shows that screen, and a screenshot; for each rotation, the display
// dump. A screen that never shows leaves its last dump, a screenshot and a
// logcat tail. The "Check fixtures" workflow runs it in CI.
//
// Run it from the root of the repository, after `pnpm install` and the build,
// on one booted emulator with a clean system image. Don't run it on a phone.
// It downloads Expo Go, installs it, starts Metro, and changes the rotation
// and the cutout overlay of the emulator.
//
// Usage: node scripts/record-check-fixtures.mjs <out-dir>
// With more than one device, set ANDROID_SERIAL to the emulator first.

import { spawnSync } from 'node:child_process'
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
import { ADB, capture, keepTimeout, loupe, showRoute } from './lib/recorder.mjs'

const [out] = process.argv.slice(2)
if (!out) {
  console.error('Usage: node scripts/record-check-fixtures.mjs <out-dir>')
  process.exit(2)
}
mkdirSync(out, { recursive: true })

// The same lists as apps/probe-app/patterns.tsx.
const PATTERNS = [
  'inset',
  'sheet',
  'sides',
  'overflow',
  'target',
  'centred',
  'mirrored',
]
const ROUTES = PATTERNS.flatMap((pattern) =>
  ['defect', 'fixed'].map((variant) => `/${pattern}/${variant}`),
)
const ROTATIONS = [
  [0, 'portrait'],
  [1, 'landscape-left'],
  [3, 'landscape-right'],
]
const CUTOUT = 'com.android.internal.display.cutout.emulation.hole'

let failures = 0

function fail(what) {
  failures += 1
  console.error(`FAIL: ${what}`)
}

/** The file name of a route: /inset/defect gives inset-defect. */
const nameOf = (route) => route.slice(1).replaceAll('/', '-')

/** Each screen of one direction: Metro serves the app in that direction. */
async function recordDirection(direction) {
  const metro = startMetro(
    path.join(out, `metro-${direction}.log`),
    direction === 'rtl' ? { PROBE_APP_RTL: '1' } : {},
  )
  try {
    const warm = await warmMetro(metro)
    console.log(`${direction}: Metro is warm after ${warm} ms.`)
    // Expo Go applies forcesRTL when it loads the app, so it starts fresh.
    spawnSync(ADB, ['shell', 'am', 'force-stop', EXPO_GO])

    const openLog = []
    const first = await showRoute(
      ROUTES[0],
      direction,
      undefined,
      300_000,
      openLog,
    )
    writeFileSync(
      path.join(out, direction, 'open.txt'),
      `${openLog.join('\n')}\n`,
    )
    if (!first.matched) {
      fail(`${direction}: the app never showed ${ROUTES[0]} in ${direction}`)
      keepTimeout(path.join(out, direction, 'open-timeout'), first.dump)
      return
    }

    for (const [rotation, orientation] of ROTATIONS) {
      const dir = path.join(out, direction, `rotation-${rotation}`)
      const shape = rotation === 0 ? 'portrait' : 'landscape'
      const log = []
      mkdirSync(dir, { recursive: true })
      // Expo Go is in front, and follows the user rotation.
      if (!loupe('rotate', orientation).ok) {
        fail(`${direction}: rotate ${orientation}`)
        continue
      }

      for (const route of ROUTES) {
        const name = nameOf(route)
        const shown = await showRoute(route, direction, shape, 60_000, log)
        if (!shown.matched) {
          fail(`${direction}/${orientation}: no probe for ${route}`)
          keepTimeout(path.join(dir, `${name}.timeout`), shown.dump)
          continue
        }
        writeFileSync(path.join(dir, `${name}.ui-tty.txt`), shown.dump)
        capture(path.join(dir, `${name}.png`), ['exec-out', 'screencap', '-p'])
        if (route === ROUTES[0]) {
          capture(path.join(dir, 'dumpsys-window-displays.txt'), [
            'shell',
            'dumpsys',
            'window',
            'displays',
          ])
          capture(path.join(dir, 'wm-size.txt'), ['shell', 'wm', 'size'])
        }
      }
      writeFileSync(path.join(dir, 'waits.txt'), `${log.join('\n')}\n`)
      console.log(`${direction}/${orientation}: done`)
    }
  } finally {
    await stopMetro(metro)
  }
}

capture(path.join(out, 'host/adb-devices-l.txt'), ['devices', '-l'])
capture(path.join(out, 'device/getprop.txt'), ['shell', 'getprop'])

try {
  const sdk = await installExpoGo(ADB)
  console.log(`Expo Go for SDK ${sdk} is in.`)
  capture(path.join(out, 'open/reverse.txt'), [
    'reverse',
    `tcp:${PORT}`,
    `tcp:${PORT}`,
  ])
  capture(path.join(out, 'cutout/overlay-enable.txt'), [
    'shell',
    'cmd',
    'overlay',
    'enable',
    CUTOUT,
  ])
  await sleep(3000)

  for (const direction of ['ltr', 'rtl']) {
    mkdirSync(path.join(out, direction), { recursive: true })
    await recordDirection(direction)
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error))
} finally {
  loupe('rotate', 'portrait')
  capture(path.join(out, 'cutout/overlay-disable.txt'), [
    'shell',
    'cmd',
    'overlay',
    'disable',
    CUTOUT,
  ])
  spawnSync(ADB, ['shell', 'am', 'force-stop', EXPO_GO])
}

console.log(
  failures === 0
    ? 'Every screen is recorded.'
    : `${failures} screens or steps failed.`,
)
process.exit(failures === 0 ? 0 : 1)
