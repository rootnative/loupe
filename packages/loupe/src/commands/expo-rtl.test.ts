import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { runCommand } from '../core/run-command'
import { RECORD_PATH } from '../expo/app-config'
import { type FakeCall, type FakeRun } from '../testing/fake-exec'
import { fakeFetch } from '../testing/fake-fetch'
import { expoDump, expoEmulator } from '../testing/expo-go'
import {
  liveManifest,
  PROBE_APP_JSON as APP_JSON,
  removeExpoProjects,
  tempExpoProject as project,
} from '../testing/expo-project'
import { recorded } from '../testing/fixtures'
import { metroRoutes } from '../testing/metro'
import { registry } from './index'

const COLD = recorded('api-30/extra/am-start-https.txt')
const WARM = recorded('api-36/extra/am-start-https.txt')

afterAll(removeExpoProjects)

/** An API 36 emulator, and the Metro of the project in `root`. */
function emulator(
  root: string,
  dumps: readonly FakeRun[],
  live = true,
  start = COLD,
) {
  const { context, calls } = expoEmulator(36, dumps, {}, start)
  const { fetch } = fakeFetch({
    ...metroRoutes(),
    '/': liveManifest(root, live),
  })
  return { context: { ...context, fetch }, calls }
}

const ltr = expoDump(36, 'open/shown.ui-tty.txt')
const rtl = expoDump(36, 'open/shown.ui-tty.txt', (text) =>
  text.replace('"direction":"ltr"', '"direction":"rtl"'),
)
const stopsOf = (calls: readonly FakeCall[]) =>
  calls.filter((call) => call.args.includes('force-stop'))
const dumpsOf = (calls: readonly FakeCall[]) =>
  calls.filter((call) => call.args.includes('uiautomator'))

describe('expo-rtl', () => {
  it('turns RTL on and waits until the probe shows RTL on the same route', async () => {
    const root = project()
    const { context, calls } = emulator(root, [ltr, ltr, rtl])

    const result = await runCommand(
      registry,
      'expo-rtl',
      { rtl: 'on' },
      context,
    )

    expect(result).toMatchObject({
      ok: true,
      data: {
        rtl: 'on',
        file: path.join(root, 'app.json'),
        changed: true,
        link: 'exp://127.0.0.1:8081/--/appstate',
        launchState: 'cold',
        route: '/appstate',
        direction: 'rtl',
        probe: true,
        warnings: [],
      },
    })
    const appJson = JSON.parse(
      readFileSync(path.join(root, 'app.json'), 'utf8'),
    )
    expect(appJson.expo.extra).toEqual({ supportsRTL: true, forcesRTL: true })
    expect(existsSync(path.join(root, RECORD_PATH))).toBe(true)
    expect(stopsOf(calls)).toHaveLength(1)
    expect(dumpsOf(calls)).toHaveLength(3)
  })

  it('turns RTL off: app.json byte for byte, no record, and the app in LTR', async () => {
    const root = project()
    const on = emulator(root, [ltr, rtl])
    await runCommand(registry, 'expo-rtl', { rtl: 'on' }, on.context)
    const { context } = emulator(root, [rtl, ltr])

    const result = await runCommand(
      registry,
      'expo-rtl',
      { rtl: 'off' },
      context,
    )

    expect(result).toMatchObject({
      ok: true,
      data: { rtl: 'off', changed: true, direction: 'ltr' },
    })
    expect(readFileSync(path.join(root, 'app.json'), 'utf8')).toBe(APP_JSON)
    expect(existsSync(path.join(root, RECORD_PATH))).toBe(false)
  })

  it("doesn't warn of a warm start when the probe shows the new direction", async () => {
    const root = project()
    const { context } = emulator(root, [ltr, rtl], true, WARM)

    const result = await runCommand(
      registry,
      'expo-rtl',
      { rtl: 'on' },
      context,
    )

    expect(result).toMatchObject({
      ok: true,
      data: { launchState: 'warm', direction: 'rtl', warnings: [] },
    })
  })

  it('puts app.json back when the manifest never gets the change', async () => {
    const root = project()
    const { context, calls } = emulator(root, [ltr], false)

    const result = await runCommand(
      registry,
      'expo-rtl',
      { rtl: 'on', timeout: 1000 },
      context,
    )

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'unsupported',
        message: expect.stringMatching(
          /forcesRTL false\. app\.config\.js can replace extra/,
        ),
      },
    })
    expect(readFileSync(path.join(root, 'app.json'), 'utf8')).toBe(APP_JSON)
    expect(existsSync(path.join(root, RECORD_PATH))).toBe(false)
    expect(stopsOf(calls)).toHaveLength(0)
  })

  it('says how to put app.json back when the app never shows in RTL', async () => {
    const root = project()
    const { context } = emulator(root, [ltr])

    const result = await runCommand(
      registry,
      'expo-rtl',
      { rtl: 'on', timeout: 1000 },
      context,
    )

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'timeout',
        message: expect.stringMatching(
          /The last read: the app in ltr\. app\.json keeps RTL on: run expo-rtl off/,
        ),
      },
    })
    expect(existsSync(path.join(root, RECORD_PATH))).toBe(true)
  })

  it('gives unsupported and stops nothing when the app has no app.json', async () => {
    const root = project(null)
    const { context, calls } = emulator(root, [ltr])

    const result = await runCommand(
      registry,
      'expo-rtl',
      { rtl: 'on' },
      context,
    )

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'unsupported',
        message: expect.stringContaining('the extra of app.config.js'),
      },
    })
    expect(stopsOf(calls)).toHaveLength(0)
  })

  it('warns that it saw no direction when the app has no probe', async () => {
    const root = project()
    const noProbe = expoDump(36, 'open/shown.ui-tty.txt', (text) =>
      text.replace(/content-desc='loupe:[^']*'/, 'content-desc=""'),
    )
    const { context } = emulator(root, [noProbe])

    const result = await runCommand(
      registry,
      'expo-rtl',
      { rtl: 'on' },
      context,
    )

    expect(result).toMatchObject({
      ok: true,
      data: {
        link: 'exp://127.0.0.1:8081',
        probe: false,
        warnings: [expect.stringContaining("didn't see the direction")],
      },
    })
    expect(JSON.parse(JSON.stringify(result))).not.toHaveProperty(
      'data.direction',
    )
  })
})
