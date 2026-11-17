import { describe, expect, it } from 'vitest'
import { run } from '../cli/run'
import { runCommand } from '../core/run-command'
import { byCommand, fakeContext } from '../testing/fake-exec'
import { recorded } from '../testing/fixtures'
import { registry } from './index'

const ADB = 'adb -s emulator-5554'

function emulator36() {
  return fakeContext(
    byCommand({
      'adb devices -l': recorded('api-36/host/adb-devices-l.txt'),
      [`${ADB} shell getprop`]: recorded('api-36/device/getprop.txt'),
      [`${ADB} shell dumpsys window displays`]: recorded(
        'api-36/none/rotation-1/settings/dumpsys-window-displays.txt',
      ),
      [`${ADB} exec-out uiautomator dump /dev/tty`]: recorded(
        'api-36/none/rotation-1/settings.ui-tty.txt',
      ),
    }),
  )
}

describe('ui', () => {
  it('gives a result that its output schema accepts', async () => {
    const { context } = emulator36()

    expect(await runCommand(registry, 'ui', {}, context)).toMatchObject({
      ok: true,
      data: {
        orientation: 'landscape-left',
        app: 'com.android.settings',
        nodes: [{ type: 'android.widget.FrameLayout' }],
      },
    })
  })

  it('prints an outline of the tree', async () => {
    const { context } = emulator36()
    const out: string[] = []
    const io = {
      out: (text: string) => out.push(text),
      err: () => {},
      isTTY: true,
    }

    expect(await run(['ui'], io, registry, context)).toBe(0)
    const lines = out.join('\n').split('\n')
    expect(lines.slice(0, 2)).toEqual([
      'landscape-left: 914.29 × 411.43 dp (2400 × 1080 px, scale 2.625), com.android.settings',
      'FrameLayout (0, 0) 914.29 × 411.43',
    ])
    expect(lines.map((line) => line.trim())).toContain(
      'TextView #android:id/title "Network & internet" (128.76, 230.48) 166.1 × 27.05',
    )
  })

  it("gives the probe's report, and leaves its node out", async () => {
    const path = 'api-36/probe/hole/rotation-3'
    const { context } = fakeContext(
      byCommand({
        'adb devices -l': recorded('api-36/host/adb-devices-l.txt'),
        [`${ADB} shell getprop`]: recorded('api-36/device/getprop.txt'),
        [`${ADB} shell dumpsys window displays`]: recorded(
          `${path}/dumpsys-window-displays.txt`,
        ),
        [`${ADB} exec-out uiautomator dump /dev/tty`]: recorded(
          `${path}/last.ui-tty.txt`,
        ),
      }),
    )
    const out: string[] = []
    const io = {
      out: (text: string) => out.push(text),
      err: () => {},
      isTTY: true,
    }

    const result = await runCommand(registry, 'ui', {}, context)
    expect(result).toMatchObject({
      ok: true,
      data: {
        app: 'host.exp.exponent',
        probe: { route: '/', direction: 'ltr', colorScheme: 'light' },
      },
    })
    expect(JSON.stringify(result)).not.toContain('loupe:')

    expect(await run(['ui'], io, registry, context)).toBe(0)
    expect(out.join('\n').split('\n')[1]).toBe(
      'Probe: route "/", ltr, light, window 862.48 × 363.43 dp, safe area top 24, right 51.81, bottom 24, left 0 dp',
    )
  })

  it('takes --app, and reads nothing while another app is in front', async () => {
    const { context, calls } = emulator36()
    const io = { out: () => {}, err: () => {}, isTTY: false }

    expect(
      await run(['ui', '--app', 'com.example.app'], io, registry, context),
    ).toBe(1)
    expect(calls.some((call) => call.args.includes('uiautomator'))).toBe(false)
  })
})
