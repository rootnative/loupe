import { describe, expect, it } from 'vitest'
import { byCommand, type FakeRun, fakeContext } from '../../testing/fake-exec'
import { recorded } from '../../testing/fixtures'
import { selectAndroidDevice } from './devices'
import { openUrlAndroid } from './open-url'

const ADB = 'adb -s emulator-5554'
const VIEW = `${ADB} shell am start -W -a android.intent.action.VIEW -d`

function emulator(level: number, runs: Readonly<Record<string, FakeRun>>) {
  const api = `api-${level}`
  const { context, calls } = fakeContext(
    byCommand({
      'adb devices -l': recorded(`${api}/host/adb-devices-l.txt`),
      [`${ADB} shell getprop`]: recorded(`${api}/device/getprop.txt`),
      ...runs,
    }),
  )
  return { calls, target: () => selectAndroidDevice(context) }
}

describe('openUrlAndroid', () => {
  it.each([30, 36])(
    'opens a web page and gives the activity, on API %i',
    async (level) => {
      const { target } = emulator(level, {
        [`${VIEW} 'https://example.com'`]: recorded(
          `api-${level}/extra/am-start-https.txt`,
        ),
      })

      expect(
        await openUrlAndroid(await target(), 'https://example.com'),
      ).toEqual({
        url: 'https://example.com',
        activity:
          'com.android.chrome/org.chromium.chrome.browser.firstrun.FirstRunActivity',
        launchState: level === 30 ? 'cold' : 'warm',
        totalTime: level === 30 ? 669 : 740,
      })
    },
  )

  // API 30 exits with 0 here and API 36 with 1: only the text tells.
  it.each([30, 36])(
    'gives no_handler when no app opens the link, on API %i',
    async (level) => {
      const { target } = emulator(level, {
        [`${VIEW} 'loupe-fixture://nothing'`]: recorded(
          `api-${level}/extra/am-start-no-handler.txt`,
        ),
      })

      await expect(
        openUrlAndroid(await target(), 'loupe-fixture://nothing'),
      ).rejects.toMatchObject({
        code: 'no_handler',
        message: 'No app on emulator-5554 opens loupe-fixture://nothing.',
      })
    },
  )

  it('opens the link only in the app, and quotes the link', async () => {
    const url = 'exp://192.168.1.5:8081/--/settings?tab=a&b=1'
    const { calls, target } = emulator(36, {
      [`${VIEW} '${url}' -p host.exp.exponent`]: recorded(
        'api-36/extra/am-start-https.txt',
      ),
    })

    await openUrlAndroid(await target(), url, 'host.exp.exponent')

    expect(calls.at(-1)?.args.slice(-3)).toEqual([
      `'${url}'`,
      '-p',
      'host.exp.exponent',
    ])
  })

  it('names the app when it does not open the link', async () => {
    const { target } = emulator(36, {
      [`${VIEW} 'https://example.com' -p com.example.app`]: recorded(
        'api-36/extra/am-start-no-handler.txt',
      ),
    })

    await expect(
      openUrlAndroid(await target(), 'https://example.com', 'com.example.app'),
    ).rejects.toMatchObject({
      code: 'no_handler',
      message:
        "com.example.app doesn't open https://example.com on emulator-5554.",
    })
  })

  it('gives the error line of another failure', async () => {
    const { target } = emulator(36, {
      [`${VIEW} 'https://example.com'`]: {
        code: 1,
        stdout: 'Starting: Intent { }\nError: Activity class does not exist.\n',
      },
    })

    await expect(
      openUrlAndroid(await target(), 'https://example.com'),
    ).rejects.toMatchObject({
      code: 'tool_failed',
      message:
        'am start failed on emulator-5554: Activity class does not exist.',
    })
  })

  it('needs the app on a real device', async () => {
    const { context, calls } = fakeContext(
      byCommand({
        'adb devices -l': {
          stdout:
            'List of devices attached\nPHONE123               device product:phone model:Phone_Model device:phone transport_id:4\n\n',
        },
        'adb -s PHONE123 shell getprop': {
          stdout: '[ro.build.version.sdk]: [35]\n[sys.boot_completed]: [1]\n',
        },
      }),
    )

    await expect(
      openUrlAndroid(await selectAndroidDevice(context), 'https://example.com'),
    ).rejects.toMatchObject({ code: 'invalid_input' })
    expect(calls.some((call) => call.args.includes('am'))).toBe(false)
  })
})
