import { describe, expect, it } from 'vitest'
import { decodePng, type Image } from '../../core/png'
import { recordedIos } from '../../testing/fixtures'
import { pngHeader } from '../../testing/png'
import { type IosTarget } from '../select'
import { type RunnerClient, type RunnerRequest } from './runner-client'
import { captureIos } from './screenshot'

const TARGET: IosTarget = {
  udid: 'AAAAAAAA-0000-4000-8000-000000000001',
  name: 'iPhone 16 Pro',
  os: 'iOS 18.6',
}
const SHOTS = 'intel/b/screens/centred-defect'

/** A runner that answers each command from a table, and keeps the requests. */
function fakeRunner(answers: Record<string, Record<string, unknown>>) {
  const requests: RunnerRequest[] = []
  const runner: RunnerClient = {
    request: async (message) => {
      requests.push(message)
      return { ok: true, ...answers[message.cmd] }
    },
    close: () => undefined,
  }
  return { runner, requests }
}

const shot = (png: Buffer, scale = 3) => ({
  png: png.toString('base64'),
  scale,
})

function pixel({ width, data }: Image, x: number, y: number): number[] {
  return [...data.subarray((y * width + x) * 4, (y * width + x) * 4 + 3)]
}

describe('captureIos', () => {
  it('gives a portrait screen as the runner gave it, with the display in pt', async () => {
    const png = pngHeader(1206, 2622)
    const { runner, requests } = fakeRunner({
      // A simulator that never turned.
      orientation: { orientation: 'unknown' },
      screenshot: shot(png),
    })

    expect(await captureIos(runner, TARGET)).toEqual({
      png,
      pixels: { width: 1206, height: 2622 },
      display: {
        orientation: 'portrait',
        size: { width: 402, height: 874 },
        pixels: { width: 1206, height: 2622 },
        scale: 3,
      },
    })
    expect(requests.map((request) => request.cmd)).toEqual([
      'orientation',
      'screenshot',
    ])
  })

  it.each([
    ['landscapeLeft', 'landscape-left'],
    ['landscapeRight', 'landscape-right'],
  ])(
    'turns the recorded %s screen upright',
    async (name, orientation) => {
      const { runner } = fakeRunner({
        orientation: { orientation: name },
        screenshot: shot(recordedIos(`${SHOTS}/${name}.png`)),
      })
      const capture = await captureIos(runner, TARGET)

      expect(capture.pixels).toEqual({ width: 2622, height: 1206 })
      expect(capture.display).toEqual({
        orientation,
        size: { width: 874, height: 402 },
        pixels: { width: 2622, height: 1206 },
        scale: 3,
      })
      // The bar of the app is at the top, the page below it, and the black
      // home indicator at the bottom, in the middle.
      const image = decodePng(capture.png)
      const [barRed = 0, , barBlue = 0] = pixel(image, 600, 100)
      const [pageRed = 0, , pageBlue = 0] = pixel(image, 1311, 800)
      expect(barBlue).toBeGreaterThan(barRed)
      expect(pageRed).toBeGreaterThan(pageBlue)
      expect(Math.max(...pixel(image, 1311, 1175))).toBeLessThan(40)
    },
    30_000,
  )

  it('asks for the state of the app before and after, with app', async () => {
    const { runner, requests } = fakeRunner({
      state: { state: 'runningForeground' },
      orientation: { orientation: 'portrait' },
      screenshot: shot(pngHeader(1206, 2622)),
    })
    await captureIos(runner, TARGET, 'host.exp.Exponent')

    expect(requests).toEqual([
      { cmd: 'state', app: 'host.exp.Exponent' },
      { cmd: 'orientation' },
      { cmd: 'screenshot' },
      { cmd: 'state', app: 'host.exp.Exponent' },
    ])
  })

  it('gives app_not_in_front, and takes no screenshot, when the app is not in front', async () => {
    const { runner, requests } = fakeRunner({
      state: { state: 'runningBackground' },
    })

    await expect(
      captureIos(runner, TARGET, 'com.example.app'),
    ).rejects.toMatchObject({
      code: 'app_not_in_front',
      message:
        "com.example.app isn't in front of iPhone 16 Pro: its state is runningBackground. Open it, then try again.",
    })
    expect(requests).toHaveLength(1)
  })

  it('fails with tool_failed when the answer has no PNG or no scale', async () => {
    const none = fakeRunner({ screenshot: { png: '', scale: 3 } })
    await expect(captureIos(none.runner, TARGET)).rejects.toMatchObject({
      code: 'tool_failed',
    })

    const old = fakeRunner({
      screenshot: { png: pngHeader(1206, 2622).toString('base64') },
    })
    await expect(captureIos(old.runner, TARGET)).rejects.toMatchObject({
      code: 'tool_failed',
      message:
        "The iOS runner on iPhone 16 Pro didn't give a PNG and the scale of the screen.",
    })
  })
})
