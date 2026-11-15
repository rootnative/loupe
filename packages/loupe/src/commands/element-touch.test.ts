import { describe, expect, it } from 'vitest'
import { run } from '../cli/run'
import { byCommand, type FakeRun, fakeContext } from '../testing/fake-exec'
import { recorded } from '../testing/fixtures'
import { registry } from './index'

const ADB = 'adb -s emulator-5554'

/** The recorded Settings home page in landscape, on API 36. */
function emulator36(runs: Readonly<Record<string, FakeRun>> = {}) {
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
      ...runs,
    }),
  )
}

async function runCli(
  args: string[],
  runs: Readonly<Record<string, FakeRun>> = {},
) {
  const { context, calls } = emulator36(runs)
  const out: string[] = []
  const err: string[] = []
  const io = {
    out: (text: string) => out.push(text),
    err: (text: string) => err.push(text),
    isTTY: true,
  }
  const code = await run(args, io, registry, context)
  const inputs = calls
    .filter((call) => call.args.includes('input'))
    .map((call) => call.args.slice(call.args.indexOf('input')).join(' '))
  return { code, out, err: err.join('\n'), inputs }
}

describe('touches on an element', () => {
  it('tap --text taps the centre of the element', async () => {
    expect(
      await runCli(['tap', '--text', 'Network & internet'], {
        [`${ADB} shell input tap 556 641`]: {},
      }),
    ).toMatchObject({
      code: 0,
      out: [
        'Tapped "Network & internet" at (211.81, 244) dp, (556, 641) px in landscape-left',
      ],
      inputs: ['input tap 556 641'],
    })
  })

  it('hold --id takes the id without its package', async () => {
    expect(
      await runCli(['hold', '--id', 'search_action_bar'], {
        [`${ADB} shell input swipe 1264 179 1264 179 1000`]: {},
      }),
    ).toMatchObject({
      code: 0,
      out: [
        'Held #com.android.settings:id/search_action_bar at (481.52, 68) dp for 1000 ms',
      ],
    })
  })

  // The tree has 4 titles. The 4th, "Apps", has the bounds [338,1059]
  // [460,1017] in the recording: cut at the bottom edge, with a negative
  // height, so it isn't on the screen.
  it('double-tap --id lists the elements when more than one matches', async () => {
    const { code, err, inputs } = await runCli(['double-tap', '--id', 'title'])

    expect(code).toBe(1)
    expect(err).toContain('3 elements on the screen have the id "title"')
    expect(inputs).toEqual([])
  })

  it('names close texts when no element matches', async () => {
    const { code, err } = await runCli(['tap', '--text', 'network'])

    expect(code).toBe(1)
    expect(err).toContain('Close ones: "Network & internet".')
  })

  it.each([
    [['tap']],
    [['tap', '100']],
    [['tap', '100', '200', '--text', 'Network & internet']],
    [['hold', '--text', 'A', '--id', 'b']],
  ])('refuses %j with a usage error', async (args) => {
    const { code, inputs } = await runCli(args)

    expect(code).toBe(2)
    expect(inputs).toEqual([])
  })

  it('reads no tree while another app is in front', async () => {
    const { code } = await runCli([
      'tap',
      '--text',
      'Network & internet',
      '--app',
      'com.example.app',
    ])

    expect(code).toBe(1)
  })
})
