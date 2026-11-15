import { describe, expect, it } from 'vitest'
import { run } from '../cli/run'
import { byCommand, type FakeRun, fakeContext } from '../testing/fake-exec'
import { recorded } from '../testing/fixtures'
import { registry } from './index'

const ADB = 'adb -s emulator-5554'

async function runCli(
  args: string[],
  runs: Readonly<Record<string, FakeRun>> = {},
) {
  const { context, calls } = fakeContext(
    byCommand({
      'adb devices -l': recorded('api-36/host/adb-devices-l.txt'),
      [`${ADB} shell getprop`]: recorded('api-36/device/getprop.txt'),
      [`${ADB} shell dumpsys window displays`]: recorded(
        'api-36/none/rotation-1/settings/dumpsys-window-displays.txt',
      ),
      ...runs,
    }),
  )
  const out: string[] = []
  const io = {
    out: (text: string) => out.push(text),
    err: () => {},
    isTTY: true,
  }
  return { code: await run(args, io, registry, context), out, calls }
}

describe('type, key and open-url', () => {
  it('type takes the text by position, and prints its length only', async () => {
    expect(
      await runCli(['type', 'hello world'], {
        [`${ADB} shell input text 'hello world'`]: {},
      }),
    ).toMatchObject({ code: 0, out: ['Typed 11 characters'] })
  })

  it('key takes the name by position', async () => {
    expect(
      await runCli(['key', 'back'], {
        [`${ADB} shell input keyevent KEYCODE_BACK`]: {},
      }),
    ).toMatchObject({ code: 0, out: ['Pressed back'] })
  })

  it('open-url prints the activity and the start time', async () => {
    expect(
      await runCli(['open-url', 'https://example.com'], {
        [`${ADB} shell am start -W -a android.intent.action.VIEW -d 'https://example.com'`]:
          recorded('api-36/extra/am-start-https.txt'),
      }),
    ).toMatchObject({
      code: 0,
      out: [
        'Opened https://example.com in com.android.chrome/org.chromium.chrome.browser.firstrun.FirstRunActivity (warm, 740 ms)',
      ],
    })
  })

  it.each([
    [['key', 'power']],
    [['open-url', 'example.com']],
    [['open-url', 'https://example.com/a b']],
    [['type', 'x', '--app', "x'; reboot"]],
  ])('refuses %j with a usage error', async (args) => {
    const { code, calls } = await runCli(args)

    expect(code).toBe(2)
    expect(calls).toEqual([])
  })
})
