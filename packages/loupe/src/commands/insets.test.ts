import { describe, expect, it } from 'vitest'
import { run } from '../cli/run'
import { runCommand } from '../core/run-command'
import { byCommand, fakeContext } from '../testing/fake-exec'
import { recorded } from '../testing/fixtures'
import { registry } from './index'

const ADB = 'adb -s emulator-5554'

function emulator30() {
  return fakeContext(
    byCommand({
      'adb devices -l': recorded('api-30/host/adb-devices-l.txt'),
      [`${ADB} shell getprop`]: recorded('api-30/device/getprop.txt'),
      [`${ADB} shell dumpsys window displays`]: recorded(
        'api-30/hole/rotation-3/settings/dumpsys-window-displays.txt',
      ),
    }),
  )
}

describe('insets', () => {
  it('gives a result that its output schema accepts, with one dump', async () => {
    const { context, calls } = emulator30()

    expect(await runCommand(registry, 'insets', {}, context)).toMatchObject({
      ok: true,
      data: { orientation: 'landscape-right', source: 'dumpsys' },
    })
    expect(calls.filter((call) => call.args.includes('dumpsys'))).toHaveLength(
      1,
    )
  })

  it('prints the safe area, the system bars and the cutout', async () => {
    const { context } = emulator30()
    const out: string[] = []
    const io = {
      out: (text: string) => out.push(text),
      err: () => {},
      isTTY: true,
    }

    expect(await run(['insets'], io, registry, context)).toBe(0)
    expect(out.join('\n').split('\n')).toEqual([
      'landscape-right: 914.29 × 411.43 dp (2400 × 1080 px, scale 2.625)',
      'Safe area: top 28.19, right 51.81, bottom 0, left 48 dp',
      'System bars: top 28.19, right 0, bottom 0, left 48 dp',
      'Cutout: top 0, right 51.81, bottom 0, left 0 dp',
    ])
  })
})
