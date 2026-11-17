import { describe, expect, it } from 'vitest'
import { run } from '../cli/run'
import { runCommand } from '../core/run-command'
import { byCommand, type FakeRun, fakeContext } from '../testing/fake-exec'
import { recorded } from '../testing/fixtures'
import { registry } from './index'

const ADB = 'adb -s emulator-5554'

/** The probe app in Expo Go on API 30, in landscape-right (round 5). */
function emulator30(dump?: FakeRun) {
  const path = 'api-30/probe/hole/rotation-3'
  return fakeContext(
    byCommand({
      'adb devices -l': recorded('api-30/host/adb-devices-l.txt'),
      [`${ADB} shell getprop`]: recorded('api-30/device/getprop.txt'),
      [`${ADB} shell dumpsys window displays`]: recorded(
        `${path}/dumpsys-window-displays.txt`,
      ),
      [`${ADB} exec-out uiautomator dump /dev/tty`]:
        dump ?? recorded(`${path}/last.ui-tty.txt`),
    }),
  )
}

function printed() {
  const out: string[] = []
  const io = {
    out: (text: string) => out.push(text),
    err: () => {},
    isTTY: true,
  }
  return { io, lines: () => out.join('\n').split('\n') }
}

describe('insets', () => {
  it('gives a result that its output schema accepts, with one dump of the screen', async () => {
    const { context, calls } = emulator30()

    expect(await runCommand(registry, 'insets', {}, context)).toMatchObject({
      ok: true,
      data: { orientation: 'landscape-right', source: 'probe' },
    })
    expect(
      calls.filter((call) => call.args.includes('uiautomator')),
    ).toHaveLength(1)
  })

  it('prints the safe area of the probe, the system bars and the cutout', async () => {
    const { context } = emulator30()
    const { io, lines } = printed()

    expect(await run(['insets'], io, registry, context)).toBe(0)
    expect(lines()).toEqual([
      'landscape-right: 914.29 × 411.43 dp (2400 × 1080 px, scale 2.625)',
      "Safe area, from the app's probe: top 28.19, right 51.81, bottom 0, left 48 dp",
      'System bars: top 28.19, right 0, bottom 0, left 48 dp',
      'Cutout: top 0, right 51.81, bottom 0, left 0 dp',
    ])
  })

  it('says when the safe area comes from dumpsys', async () => {
    const { context } = emulator30({
      stdout: 'ERROR: could not get idle state.\n',
    })
    const { io, lines } = printed()

    expect(await run(['insets'], io, registry, context)).toBe(0)
    expect(lines()[1]).toBe(
      'Safe area, from dumpsys: top 28.19, right 51.81, bottom 0, left 48 dp',
    )
    expect(lines()[4]).toMatch(/^Warning: The screen didn't keep still/)
  })

  it('takes --app, and reads nothing while another app is in front', async () => {
    const { context, calls } = emulator30()
    const io = { out: () => {}, err: () => {}, isTTY: false }

    expect(
      await run(['insets', '--app', 'com.example.app'], io, registry, context),
    ).toBe(1)
    expect(calls.some((call) => call.args.includes('uiautomator'))).toBe(false)
  })
})
