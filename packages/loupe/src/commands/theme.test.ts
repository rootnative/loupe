import { describe, expect, it } from 'vitest'
import { run } from '../cli/run'
import { byCommand, type FakeRun, fakeContext } from '../testing/fake-exec'
import { recorded } from '../testing/fixtures'
import { registry } from './index'

const ADB = 'adb -s emulator-5554'
const PROBE = 'api-36/probe'

/** An API 36 emulator with the probe app in light mode (round 5). */
function emulator(dumps: readonly FakeRun[]) {
  const { context } = fakeContext(
    byCommand({
      'adb devices -l': recorded('api-36/host/adb-devices-l.txt'),
      [`${ADB} shell getprop`]: recorded('api-36/device/getprop.txt'),
      [`${ADB} shell dumpsys window displays`]: recorded(
        'api-36/sheets/alert/back/before.dumpsys-window-displays.txt',
      ),
      [`${ADB} shell cmd uimode night`]: recorded(
        `${PROBE}/device/uimode-night-at-start.txt`,
      ),
      [`${ADB} shell cmd uimode night yes`]: recorded(
        `${PROBE}/night/uimode-yes.txt`,
      ),
      [`${ADB} exec-out uiautomator dump /dev/tty`]: dumps,
    }),
  )
  return context
}

const DARK = recorded(`${PROBE}/night/last.ui-tty.txt`)
const LIGHT = recorded(`${PROBE}/night/light/last.ui-tty.txt`)

async function cli(args: string[], dumps: readonly FakeRun[], isTTY = true) {
  const out: string[] = []
  const errors: string[] = []
  const io = {
    out: (text: string) => out.push(text),
    err: (text: string) => errors.push(text),
    isTTY,
  }
  const code = await run(args, io, registry, emulator(dumps))
  return { code, out: out.join('\n'), errors: errors.join('\n') }
}

describe('theme', () => {
  it('reads the setting with no theme', async () => {
    expect(await cli(['theme'], [DARK])).toEqual({
      code: 0,
      out: 'The theme is light.',
      errors: '',
    })
  })

  it('sets the theme, and says when the probe showed it', async () => {
    const { code, out } = await cli(
      ['theme', 'dark', '--app', 'host.exp.exponent'],
      [LIGHT, DARK],
    )

    expect(code).toBe(0)
    expect(out).toMatch(
      /^Set the theme to dark \(it was light\)\. The app's probe shows it after \d+ ms\.$/,
    )
  })

  it('gives the warning when the probe keeps the other scheme', async () => {
    const { code, out } = await cli(
      ['theme', 'dark', '--timeout', '0'],
      [LIGHT],
      false,
    )

    expect(code).toBe(0)
    expect(JSON.parse(out)).toMatchObject({
      ok: true,
      data: {
        theme: 'dark',
        was: 'light',
        source: 'setting',
        warnings: [expect.stringContaining('the probe still shows light')],
      },
    })
  })
})
