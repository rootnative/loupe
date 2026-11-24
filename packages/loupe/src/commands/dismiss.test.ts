import { describe, expect, it } from 'vitest'
import { run } from '../cli/run'
import { byCommand, fakeContext } from '../testing/fake-exec'
import { recorded, recordedText } from '../testing/fixtures'
import { registry } from './index'

const ADB = 'adb -s emulator-5554'
const SHEETS = 'api-36/sheets/alert/back'
const MAIN = recordedText(`${SHEETS}/before.dumpsys-window-displays.txt`)
const DIALOG = recordedText(`${SHEETS}/open.dumpsys-window-displays.txt`)
const APP = recordedText('api-36/probe/night/light/last.ui-tty.txt')
const OVERLAY = APP.replace(
  '</hierarchy>',
  '<node index="9" text="" resource-id="scrim" class="android.widget.Button" package="host.exp.exponent" content-desc="Close overlay" clickable="true" long-clickable="false" bounds="[0,0][1080,2400]" /></hierarchy>',
)
const SHADE = MAIN.replace(
  /mCurrentFocus=Window\{\S+ u0 [^}]+\}/,
  'mCurrentFocus=Window{5e7a11 u0 NotificationShade}',
)

/**
 * An API 36 emulator with Expo Go (round 8), these display dumps, and these
 * dumps of the app's screen.
 */
function emulator(displays: readonly string[], screens = [APP]) {
  const { context } = fakeContext(
    byCommand({
      'adb devices -l': recorded('api-36/host/adb-devices-l.txt'),
      [`${ADB} shell getprop`]: recorded('api-36/device/getprop.txt'),
      [`${ADB} shell dumpsys window displays`]: displays.map((stdout) => ({
        stdout,
      })),
      [`${ADB} shell dumpsys window windows`]: recorded(
        `${SHEETS}/open.dumpsys-window-windows.txt`,
      ),
      // No input focus to read, so dismiss doesn't wait for it before a key.
      // The driver's tests cover that wait.
      [`${ADB} shell dumpsys input`]: {
        stdout: 'INPUT MANAGER (dumpsys input)\n',
      },
      [`${ADB} shell input keyevent KEYCODE_BACK`]: {},
      [`${ADB} shell cmd statusbar collapse`]: {},
      [`${ADB} exec-out uiautomator dump /dev/tty`]: screens.map((stdout) => ({
        stdout,
      })),
    }),
  )
  return context
}

async function cli(
  args: string[],
  displays: readonly string[],
  isTTY = true,
  screens?: string[],
) {
  const out: string[] = []
  const errors: string[] = []
  const io = {
    out: (text: string) => out.push(text),
    err: (text: string) => errors.push(text),
    isTTY,
  }
  const code = await run(args, io, registry, emulator(displays, screens))
  return { code, out: out.join('\n'), errors: errors.join('\n') }
}

describe('dismiss', () => {
  it('says when nothing was open', async () => {
    expect(
      await cli(['dismiss', '--app', 'host.exp.exponent'], [MAIN]),
    ).toEqual({
      code: 0,
      out: 'Nothing is open over host.exp.exponent: loupe sent no key.',
      errors: '',
    })
  })

  it('names what it closed, and the layer that shows now', async () => {
    const { code, out } = await cli(['dismiss'], [SHADE, DIALOG])

    expect(code).toBe(0)
    expect(out).toMatch(
      /^Closed the notification shade with a status bar collapse \(\d+ ms\)\. The app's dialog shows now: run dismiss again, or dismiss --all\.$/,
    )
  })

  it('closes each layer with --all, and gives each one', async () => {
    const { code, out } = await cli(
      ['dismiss', '--all', '--app', 'host.exp.exponent'],
      [SHADE, DIALOG, MAIN],
      false,
    )

    expect(code).toBe(0)
    expect(JSON.parse(out)).toMatchObject({
      ok: true,
      data: {
        app: 'host.exp.exponent',
        closed: [
          { layer: 'notification-shade', way: 'collapse' },
          { layer: 'app-dialog', way: 'back' },
        ],
      },
    })
  })

  it("names the app's overlay by its label", async () => {
    const { code, out } = await cli(
      ['dismiss', '--app', 'host.exp.exponent'],
      [MAIN],
      true,
      [OVERLAY, APP],
    )

    expect(code).toBe(0)
    expect(out).toMatch(
      /^Closed the app's overlay "Close overlay" with Back \(\d+ ms\)\.$/,
    )
  })
})
