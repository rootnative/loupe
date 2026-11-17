// Shared by the scripts that open the probe app in Expo Go on an emulator:
// the smoke run and the check recorder. Run them from the root of the
// repository, after `pnpm install` and the build.

import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, openSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

export const EXPO_GO = 'host.exp.exponent'
export const PORT = 8081
export const PROBE_APP = path.resolve('apps/probe-app')

const appRequire = () => createRequire(path.join(PROBE_APP, 'package.json'))

/**
 * Installs Expo Go for the SDK of the probe app, from the versions list that
 * the Expo CLI reads too. `-g` grants the permissions, so no permission
 * dialog covers the app. Gives the SDK version.
 */
export async function installExpoGo(adb) {
  const sdk = `${appRequire()('expo/package.json').version.split('.')[0]}.0.0`
  const list = await fetch('https://api.expo.dev/v2/versions/latest')
  const url = (await list.json()).data?.sdkVersions?.[sdk]?.androidClientUrl
  if (!url) {
    throw new Error(`The Expo versions list has no Expo Go for SDK ${sdk}.`)
  }

  const download = await fetch(url)
  if (!download.ok) {
    throw new Error(`Expo Go didn't download: HTTP ${download.status}.`)
  }
  const apk = path.join(
    mkdtempSync(path.join(tmpdir(), 'expo-go-')),
    'expo-go.apk',
  )
  writeFileSync(apk, Buffer.from(await download.arrayBuffer()))

  const install = spawnSync(adb, ['install', '-r', '-g', apk], {
    encoding: 'utf8',
    timeout: 300_000,
  })
  if (install.status !== 0) {
    throw new Error(
      `Expo Go didn't install: ${install.stdout}${install.stderr}`,
    )
  }
  return sdk
}

/**
 * Starts Metro for the probe app on localhost only; `adb reverse` gives the
 * port to the emulator. The log goes to `logFile`. `env` adds variables,
 * for example `PROBE_APP_RTL: '1'`.
 */
export function startMetro(logFile, env = {}) {
  const log = openSync(logFile, 'w')
  return spawn(
    process.execPath,
    [
      appRequire().resolve('expo/bin/cli'),
      'start',
      '--localhost',
      '--port',
      String(PORT),
    ],
    {
      cwd: PROBE_APP,
      env: { ...process.env, CI: '1', EXPO_NO_TELEMETRY: '1', ...env },
      stdio: ['ignore', log, log],
    },
  )
}

/** Stops Metro, and waits until it has exited, so the port is free. */
export async function stopMetro(metro) {
  if (metro.exitCode !== null || metro.signalCode !== null) return
  metro.kill()
  await Promise.race([once(metro, 'exit'), sleep(10_000)])
}

/**
 * Waits until Metro runs, then fetches the bundle once: a cold bundle can
 * take longer than Expo Go waits. Gives the time in ms.
 */
export async function warmMetro(metro) {
  const start = Date.now()
  const base = `http://127.0.0.1:${PORT}`
  for (;;) {
    if (metro.exitCode !== null) {
      throw new Error('Metro stopped. See the Metro log.')
    }
    const status = await fetch(`${base}/status`)
      .then((response) => response.text())
      .catch(() => '')
    if (status.includes('packager-status:running')) break
    if (Date.now() - start > 180_000) {
      throw new Error("Metro didn't start in 3 minutes. See the Metro log.")
    }
    await sleep(1000)
  }

  const manifest = await fetch(base, {
    headers: {
      'expo-platform': 'android',
      accept: 'application/expo+json,application/json',
    },
  }).then((response) => response.json())
  const bundle = await fetch(manifest.launchAsset.url, {
    signal: AbortSignal.timeout(600_000),
  })
  await bundle.arrayBuffer()
  if (!bundle.ok) {
    throw new Error(`Metro didn't give the bundle: HTTP ${bundle.status}.`)
  }
  return Date.now() - start
}
