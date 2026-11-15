import { describe, expect, it } from 'vitest'
import { run } from '../cli/run'
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
      [`${ADB} shell input tap 263 525`]: {},
      [`${ADB} shell input swipe 263 525 263 525 1000`]: {},
      [`${ADB} shell input swipe 263 525 788 525 500`]: {},
    }),
  )
}

async function runCli(args: string[]) {
  const { context } = emulator36()
  const out: string[] = []
  const io = {
    out: (text: string) => out.push(text),
    err: () => {},
    isTTY: true,
  }
  return { code: await run(args, io, registry, context), out }
}

describe('the touch commands', () => {
  it.each([
    [
      ['tap', '100', '200'],
      'Tapped (100, 200) dp, (263, 525) px in landscape-left',
    ],
    [['hold', '100', '200'], 'Held (100, 200) dp for 1000 ms'],
    [
      ['swipe', '100', '200', '300', '200', '--duration', '500'],
      'Swiped (100, 200) → (300, 200) dp in 500 ms',
    ],
  ])('%j takes the points by position', async (args, summary) => {
    expect(await runCli(args)).toEqual({ code: 0, out: [summary] })
  })

  it('needs both coordinates', async () => {
    expect((await runCli(['tap', '100'])).code).toBe(2)
  })
})
