import { describe, expect, it } from 'vitest'
import { run } from '../cli/run'
import { decodePng, encodePng } from '../core/png'
import { runCommand } from '../core/run-command'
import { byCommand, type FakeRun, fakeContext } from '../testing/fake-exec'
import { recorded } from '../testing/fixtures'
import { registry } from './index'

const ADB = 'adb -s emulator-5554'
const SETTINGS = recorded('api-36/none/rotation-1/settings.png')
const TREE = recorded('api-36/none/rotation-1/settings.ui-tty.txt')
const NOT_IDLE = { stdout: 'ERROR: could not get idle state.\n' }

/** The Settings screen with one pixel changed, at x, y in px. */
function changed(x: number, y: number): FakeRun {
  const image = decodePng(Buffer.from(SETTINGS.stdout ?? ''))
  const at = (y * image.width + x) * 4
  image.data[at] = (image.data[at] ?? 0) ^ 0xff
  return { stdout: encodePng(image) }
}

/**
 * Settings on API 36, in landscape-left. The status bar is the top 63 px,
 * and the gesture bar the bottom 63 px.
 */
function emulator36(
  screens: readonly FakeRun[] = [SETTINGS],
  trees: readonly FakeRun[] = [TREE],
  runs: Readonly<Record<string, FakeRun>> = {},
) {
  return fakeContext(
    byCommand({
      'adb devices -l': recorded('api-36/host/adb-devices-l.txt'),
      [`${ADB} shell getprop`]: recorded('api-36/device/getprop.txt'),
      [`${ADB} shell dumpsys window displays`]: recorded(
        'api-36/none/rotation-1/settings/dumpsys-window-displays.txt',
      ),
      [`${ADB} exec-out screencap -p`]: screens,
      [`${ADB} exec-out uiautomator dump /dev/tty`]: trees,
      ...runs,
    }),
  )
}

async function runCli(args: string[], context = emulator36().context) {
  const out: string[] = []
  const errors: string[] = []
  const io = {
    out: (text: string) => out.push(text),
    err: (text: string) => errors.push(text),
    isTTY: true,
  }
  const code = await run(args, io, registry, context)
  return { code, out: out.join('\n'), errors: errors.join('\n') }
}

const FAST = { interval: 0 }

describe('wait --still', () => {
  it('stops at two equal screenshots', async () => {
    const { context } = emulator36()

    expect(
      await runCommand(registry, 'wait', { still: true, ...FAST }, context),
    ).toMatchObject({ ok: true, data: { frames: 2 } })
  })

  it('leaves out the system bars: a change in the status bar is still', async () => {
    const { context } = emulator36([SETTINGS, changed(1200, 10)])

    expect(
      await runCommand(registry, 'wait', { still: true, ...FAST }, context),
    ).toMatchObject({ ok: true, data: { frames: 2 } })
  })

  it('gives timeout when the screen moves', async () => {
    const { context } = emulator36([SETTINGS, changed(1200, 540)])

    expect(
      await runCommand(
        registry,
        'wait',
        { still: true, timeout: 0, ...FAST },
        context,
      ),
    ).toMatchObject({
      ok: false,
      error: {
        code: 'timeout',
        message: expect.stringMatching(
          /^The screen didn't keep still in \d+ ms \(2 screenshots\)\./,
        ),
      },
    })
  })

  it('prints a summary', async () => {
    const { out } = await runCli(['wait', '--still', '--interval', '0'])

    expect(out).toMatch(
      /^The screen keeps still, after [\d.]+ s \(2 screenshots\)\.$/,
    )
  })
})

describe('wait --text', () => {
  it('reads until the element is on the screen', async () => {
    const { context } = emulator36(undefined, [NOT_IDLE, TREE])

    expect(
      await runCommand(
        registry,
        'wait',
        { text: 'Network & internet', ...FAST },
        context,
      ),
    ).toMatchObject({
      ok: true,
      data: {
        reads: 2,
        element: {
          type: 'android.widget.TextView',
          text: 'Network & internet',
        },
      },
    })
  })

  it('gives timeout with the last error it went past', async () => {
    const { context } = emulator36(undefined, [NOT_IDLE])

    expect(
      await runCommand(
        registry,
        'wait',
        { label: 'Nothing', timeout: 0, ...FAST },
        context,
      ),
    ).toMatchObject({
      ok: false,
      error: {
        code: 'timeout',
        message: expect.stringMatching(
          /^No element with the label "Nothing" came on the screen in \d+ ms \(1 reads\)\. The last read said: The screen of emulator-5554 didn't keep still/,
        ),
      },
    })
  })

  it('prints a summary', async () => {
    const { out } = await runCli([
      'wait',
      '--text',
      'Network & internet',
      '--interval',
      '0',
    ])

    expect(out).toMatch(
      /^"Network & internet" is on the screen, after [\d.]+ s \(1 reads\)\.$/,
    )
  })

  it.each([
    ['nothing to wait for', {}],
    ['two things', { still: true, text: 'Title' }],
    ['a timeout past 10 minutes', { still: true, timeout: 600_001 }],
  ])('refuses %s', async (_name, input) => {
    const { context, calls } = emulator36()

    expect(await runCommand(registry, 'wait', input, context)).toMatchObject({
      ok: false,
      error: { code: 'invalid_input' },
    })
    expect(calls.some((call) => call.args.includes('screencap'))).toBe(false)
  })
})

describe('the wait options of the actions', () => {
  const TAP = { [`${ADB} shell input tap 263 525`]: {} }

  it('tap --wait-still waits after the tap', async () => {
    const { context } = emulator36(undefined, undefined, TAP)

    const { code, out } = await runCli(
      ['tap', '100', '200', '--wait-still'],
      context,
    )

    expect(code).toBe(0)
    expect(out).toMatch(
      /^Tapped \(100, 200\) dp, \(263, 525\) px in landscape-left\nThen waited [\d.]+ s until still \(2 screenshots\)\.$/,
    )
  })

  it('gives timeout, and says that the tap ran, when the screen keeps moving', async () => {
    const { context } = emulator36(
      [SETTINGS, changed(1200, 540)],
      undefined,
      TAP,
    )

    const { code, errors } = await runCli(
      ['tap', '100', '200', '--wait-still', '--wait-timeout', '0'],
      context,
    )

    expect(code).toBe(1)
    expect(errors).toContain("The tap ran, but the screen didn't keep still in")
  })

  it('open-url --wait-text waits for the text, then --wait-still', async () => {
    const { context } = emulator36(undefined, [NOT_IDLE, TREE], {
      [`${ADB} shell am start -W -a android.intent.action.VIEW -d 'https://example.com'`]:
        recorded('api-36/extra/am-start-https.txt'),
    })

    const result = await runCommand(
      registry,
      'open-url',
      {
        url: 'https://example.com',
        waitText: 'Network & internet',
        waitStill: true,
      },
      context,
    )

    expect(result).toMatchObject({
      ok: true,
      data: {
        url: 'https://example.com',
        waited: {
          reads: 2,
          frames: 2,
          element: { text: 'Network & internet' },
        },
      },
    })
  })

  it('key gives timeout, and says that the key ran, when the text never comes', async () => {
    const { context } = emulator36(undefined, undefined, {
      [`${ADB} shell input keyevent KEYCODE_BACK`]: {},
    })

    expect(
      await runCommand(
        registry,
        'key',
        { key: 'back', waitText: 'Nothing', waitTimeout: 0 },
        context,
      ),
    ).toMatchObject({
      ok: false,
      error: {
        code: 'timeout',
        message: expect.stringMatching(
          /^The key ran, but no element with the text "Nothing" came on the screen/,
        ),
      },
    })
  })

  it('gives no waited field with no wait option', async () => {
    const { context } = emulator36(undefined, undefined, TAP)

    const result = await runCommand(
      registry,
      'tap',
      { x: 100, y: 200 },
      context,
    )

    expect(result.ok && JSON.stringify(result.data)).not.toContain('waited')
  })
})
