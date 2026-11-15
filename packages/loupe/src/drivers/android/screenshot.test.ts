import { describe, expect, it } from 'vitest'
import { byCommand, type FakeRun, fakeContext } from '../../testing/fake-exec'
import { recorded } from '../../testing/fixtures'
import { selectAndroidDevice } from './devices'
import { captureAndroid } from './screenshot'

const ADB = 'adb -s emulator-5554'

function emulator(level: number, screencap: FakeRun) {
  const api = `api-${level}`
  const { context, calls } = fakeContext(
    byCommand({
      'adb devices -l': recorded(`${api}/host/adb-devices-l.txt`),
      [`${ADB} shell getprop`]: recorded(`${api}/device/getprop.txt`),
      [`${ADB} shell dumpsys window displays`]: recorded(
        `${api}/none/rotation-1/settings/dumpsys-window-displays.txt`,
      ),
      [`${ADB} exec-out screencap -p`]: screencap,
    }),
  )
  return { calls, target: () => selectAndroidDevice(context) }
}

describe.each([30, 36])('captureAndroid, on API %i', (level) => {
  it('gives the PNG upright in landscape, with the display state', async () => {
    const png = recorded(`api-${level}/none/rotation-1/settings.png`)
    const { target } = emulator(level, png)

    const capture = await captureAndroid(await target())

    expect(capture.png).toEqual(png.stdout)
    expect(capture.pixels).toEqual({ width: 2400, height: 1080 })
    expect(capture.display).toMatchObject({
      orientation: 'landscape-left',
      pixels: { width: 2400, height: 1080 },
      scale: 2.625,
    })
  })
})

describe('captureAndroid', () => {
  it('fails when screencap gives no PNG', async () => {
    const { target } = emulator(36, { stdout: 'Error: capture failed\n' })

    await expect(captureAndroid(await target())).rejects.toMatchObject({
      code: 'tool_failed',
      message: "screencap on emulator-5554 didn't give a PNG.",
    })
  })

  it('takes nothing while another app is in front', async () => {
    const { calls, target } = emulator(
      36,
      recorded('api-36/none/rotation-1/settings.png'),
    )

    await expect(
      captureAndroid(await target(), 'com.example.app'),
    ).rejects.toMatchObject({ code: 'app_not_in_front' })
    expect(calls.some((call) => call.args.includes('screencap'))).toBe(false)
  })
})
