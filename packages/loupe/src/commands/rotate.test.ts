import { describe, expect, it } from 'vitest'
import { run } from '../cli/run'
import { runCommand } from '../core/run-command'
import { byCommand, fakeContext } from '../testing/fake-exec'
import { recorded } from '../testing/fixtures'
import { registry } from './index'

const ADB = 'adb -s emulator-5554 shell'

function emulator36() {
  return fakeContext(
    byCommand({
      'adb devices -l': recorded('api-36/host/adb-devices-l.txt'),
      [`${ADB} getprop`]: recorded('api-36/device/getprop.txt'),
      [`${ADB} wm user-rotation lock 1`]: {},
      [`${ADB} dumpsys window displays`]: recorded(
        'api-36/none/rotation-1/settings/dumpsys-window-displays.txt',
      ),
    }),
  )
}

describe('rotate', () => {
  it('gives a result that its output schema accepts', async () => {
    const { context } = emulator36()

    expect(
      await runCommand(registry, 'rotate', { to: 'landscape-left' }, context),
    ).toMatchObject({
      ok: true,
      data: { orientation: 'landscape-left', scale: 2.625 },
    })
  })

  it('takes the orientation by position, and prints a summary', async () => {
    const { context } = emulator36()
    const out: string[] = []
    const io = {
      out: (text: string) => out.push(text),
      err: () => {},
      isTTY: true,
    }

    expect(await run(['rotate', 'landscape-left'], io, registry, context)).toBe(
      0,
    )
    expect(out).toEqual([
      'landscape-left: 914.29 × 411.43 dp (2400 × 1080 px, scale 2.625)',
    ])
  })

  it('refuses an orientation it does not turn to', async () => {
    const { context, calls } = emulator36()

    expect(
      await runCommand(
        registry,
        'rotate',
        { to: 'portrait-upside-down' },
        context,
      ),
    ).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
    expect(calls).toEqual([])
  })
})
