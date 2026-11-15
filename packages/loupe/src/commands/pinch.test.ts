import { describe, expect, it } from 'vitest'
import { run } from '../cli/run'
import { runCommand } from '../core/run-command'
import { byCommand, type FakeRun, fakeContext } from '../testing/fake-exec'
import { recorded } from '../testing/fixtures'
import { registry } from './index'

const ADB = 'adb -s emulator-5554'
const SEND = `${ADB} emu event send`

/** The recorded Settings home page in landscape-left. */
function emulator(
  level: 30 | 36,
  runs: Readonly<Record<string, FakeRun>> = {},
) {
  const api = `api-${level}`
  const base = byCommand({
    'adb devices -l': recorded(`${api}/host/adb-devices-l.txt`),
    [`${ADB} shell getprop`]: recorded(`${api}/device/getprop.txt`),
    [`${ADB} shell dumpsys window displays`]: recorded(
      `${api}/none/rotation-1/settings/dumpsys-window-displays.txt`,
    ),
    [`${ADB} exec-out uiautomator dump /dev/tty`]: recorded(
      `${api}/none/rotation-1/settings.ui-tty.txt`,
    ),
    ...runs,
  })
  const sent: string[][] = []
  const { context } = fakeContext((call) => {
    const key = ['adb', ...call.args].join(' ')
    if (!key.startsWith(SEND)) return base(call)
    sent.push(call.args.slice(5))
    return recorded('api-36/touch/console/event-down.txt')
  })
  return { context, sent }
}

/** The px of each finger in a send, from the raw units of a landscape-left screen. */
function fingersOf(events: readonly string[]) {
  const values = (axis: string) =>
    events
      .filter((event) => event.startsWith(`EV_ABS:ABS_MT_POSITION_${axis}:`))
      .map((event) => Number(event.split(':').at(-1)))
  const ys = values('Y')
  return values('X').map((rawX, index) => ({
    x: Math.round(((ys[index] ?? 0) * 2400) / 32768),
    y: Math.round(1080 - (rawX * 1080) / 32768),
  }))
}

describe('pinch', () => {
  it('spreads two fingers through the console, across a landscape screen', async () => {
    const { context, sent } = emulator(36)

    const result = await runCommand(
      registry,
      'pinch',
      { x: 400, y: 200, scale: 2, duration: 0 },
      context,
    )

    expect(result).toMatchObject({
      ok: true,
      data: {
        orientation: 'landscape-left',
        centre: { x: 400, y: 200 },
        span: { from: 200, to: 400 },
        angle: 0,
        turn: 0,
        duration: 0,
        fingers: [
          { from: { x: 300, y: 200 }, to: { x: 200, y: 200 } },
          { from: { x: 500, y: 200 }, to: { x: 600, y: 200 } },
        ],
      },
    })
    // A touch, 10 steps and a lift. The units turn back to the px of each
    // finger (dp × 2.625).
    expect(sent).toHaveLength(12)
    expect(fingersOf(sent[0] ?? [])).toEqual([
      { x: 788, y: 525 },
      { x: 1313, y: 525 },
    ])
    expect(fingersOf(sent[10] ?? [])).toEqual([
      { x: 525, y: 525 },
      { x: 1575, y: 525 },
    ])
    expect(sent[11]).toContain('EV_KEY:BTN_TOUCH:0')
  })

  it('works on API 30, where `input` is too slow for a gesture', async () => {
    const { context, sent } = emulator(30)

    expect(
      await runCommand(
        registry,
        'pinch',
        { x: 400, y: 200, scale: 0.5, duration: 0 },
        context,
      ),
    ).toMatchObject({ ok: true, data: { span: { from: 400, to: 200 } } })
    expect(sent).toHaveLength(12)
  })

  it('pinches the centre of an element, and prints one line', async () => {
    const { context } = emulator(36)
    const out: string[] = []
    const io = {
      out: (text: string) => out.push(text),
      err: () => {},
      isTTY: true,
    }

    expect(
      await run(
        [
          'pinch',
          '--text',
          'Network & internet',
          '--scale',
          '2',
          '--turn=-30',
          '--duration',
          '0',
        ],
        io,
        registry,
        context,
      ),
    ).toBe(0)
    expect(out.join('\n')).toMatch(
      /^Pinched "Network & internet" at \(211\.81, 244\) dp in landscape-left: 200 → 400 dp apart, turned 30° counter-clockwise; the move took \d+ ms$/,
    )
  })

  it('sends nothing when a finger would leave the screen', async () => {
    const { context, sent } = emulator(36)

    expect(
      await runCommand(
        registry,
        'pinch',
        { x: 100, y: 200, scale: 3, duration: 0 },
        context,
      ),
    ).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
    expect(sent).toEqual([])
  })

  it('refuses a real device', async () => {
    const { context } = fakeContext(
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

    expect(
      await runCommand(
        registry,
        'pinch',
        { x: 100, y: 200, scale: 2, app: 'com.example.app' },
        context,
      ),
    ).toMatchObject({ ok: false, error: { code: 'unsupported' } })
  })
})
