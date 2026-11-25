import { describe, expect, it } from 'vitest'
import { runCommand } from '../core/run-command'
import { type FakeCall } from '../testing/fake-exec'
import { fakeFetch, refused } from '../testing/fake-fetch'
import { expoDump as dump, expoEmulator, opensOf } from '../testing/expo-go'
import { recorded } from '../testing/fixtures'
import { registry } from './index'

// After a force-stop no process is left, so Android starts Expo Go cold.
// Only the launch state of these recorded starts matters here.
const COLD = recorded('api-30/extra/am-start-https.txt')
const WARM = recorded('api-36/extra/am-start-https.txt')

const indexOf = (calls: readonly FakeCall[], words: string) =>
  calls.findIndex((call) => call.args.join(' ').includes(words))
const dumpsOf = (calls: readonly FakeCall[]) =>
  calls.filter((call) => call.args.includes('uiautomator'))
const noProbe = (text: string) =>
  text.replace(/content-desc='loupe:[^']*'/, 'content-desc=""')

describe('expo-reload', () => {
  it.each([30, 36] as const)(
    'stops Expo Go and opens the route that the probe showed (API %i)',
    async (level) => {
      const { context, calls } = expoEmulator(
        level,
        [dump(level, 'open/shown.ui-tty.txt')],
        {},
        COLD,
      )

      const result = await runCommand(registry, 'expo-reload', {}, context)

      expect(result).toMatchObject({
        ok: true,
        data: {
          link: 'exp://127.0.0.1:8081/--/appstate',
          app: { name: 'Probe app', sdkVersion: '58.0.0' },
          expoGo: '58.0.6',
          launchState: 'cold',
          opens: 1,
          closed: [],
          route: '/appstate',
          probe: true,
          warnings: [],
        },
      })
      expect(dumpsOf(calls)).toHaveLength(2)
      const reverse = indexOf(calls, 'reverse tcp:8081 tcp:8081')
      const stop = indexOf(calls, 'am force-stop host.exp.exponent')
      const open = indexOf(calls, 'am start')
      expect(reverse).toBeGreaterThan(-1)
      expect(stop).toBeGreaterThan(reverse)
      expect(open).toBeGreaterThan(stop)
    },
  )

  it('opens the route that the input gives, with no read before the stop', async () => {
    const { context, calls } = expoEmulator(
      36,
      [
        dump(36, 'open/shown.ui-tty.txt', (text) =>
          text.replace('"route":"/appstate"', '"route":"/sheets"'),
        ),
      ],
      {},
      COLD,
    )

    const result = await runCommand(
      registry,
      'expo-reload',
      { route: 'sheets' },
      context,
    )

    expect(result).toMatchObject({
      ok: true,
      data: { link: 'exp://127.0.0.1:8081/--/sheets', route: '/sheets' },
    })
    expect(dumpsOf(calls)).toHaveLength(1)
    expect(opensOf(calls)[0]?.args.slice(-3)).toEqual([
      "'exp://127.0.0.1:8081/--/sheets'",
      '-p',
      'host.exp.exponent',
    ])
  })

  it('opens the root when the app has no probe', async () => {
    const { context } = expoEmulator(
      36,
      [dump(36, 'open/shown.ui-tty.txt', noProbe)],
      {},
      COLD,
    )

    const result = await runCommand(registry, 'expo-reload', {}, context)

    expect(result).toMatchObject({
      ok: true,
      data: { link: 'exp://127.0.0.1:8081', probe: false, warnings: [] },
    })
  })

  it('warns when Android starts Expo Go warm after the stop', async () => {
    const { context } = expoEmulator(
      36,
      [dump(36, 'open/shown.ui-tty.txt')],
      {},
      WARM,
    )

    const result = await runCommand(registry, 'expo-reload', {}, context)

    expect(result).toMatchObject({
      ok: true,
      data: {
        launchState: 'warm',
        warnings: [expect.stringContaining("Expo Go didn't stop")],
      },
    })
  })

  it("gives no_server and doesn't stop Expo Go when Metro doesn't run", async () => {
    const { context, calls } = expoEmulator(36, [])
    const { fetch } = fakeFetch({ '/status': refused() })

    const result = await runCommand(
      registry,
      'expo-reload',
      {},
      {
        ...context,
        fetch,
      },
    )

    expect(result).toMatchObject({ ok: false, error: { code: 'no_server' } })
    expect(indexOf(calls, 'force-stop')).toBe(-1)
  })
})
