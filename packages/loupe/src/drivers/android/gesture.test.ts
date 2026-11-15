import { describe, expect, it } from 'vitest'
import {
  byCommand,
  type FakeCall,
  type FakeRun,
  fakeContext,
} from '../../testing/fake-exec'
import { recorded } from '../../testing/fixtures'
import { pngHeader } from '../../testing/png'
import { downEvents, moveEvents, toRaw, upEvents } from './console'
import { type AndroidTarget, selectAndroidDevice } from './devices'
import { doubleTapAndroid, dragAndroid } from './gesture'

const EMULATOR = 'emulator-5554'
/** An emulator that adb reaches over TCP, so with no console. */
const TCP = '127.0.0.1:5555'
const PHONE = 'PHONE123'
const ADB = `adb -s ${EMULATOR}`
const TCP_ADB = `adb -s ${TCP}`
const SETTINGS = 'com.android.settings'
const SHOT = '/data/local/tmp/loupe-drag.png'
const DRAG = { duration: 300, holdStart: 0, holdEnd: 0 }

function devicesOf(serial: string, level: number): FakeRun {
  if (serial === EMULATOR)
    return recorded(`api-${level}/host/adb-devices-l.txt`)
  return {
    stdout: `List of devices attached\n${serial}        device product:phone model:Phone_Model device:phone transport_id:4\n\n`,
  }
}

/** A real phone has no qemu properties. */
function propsOf(serial: string, level: number): FakeRun {
  return serial === PHONE
    ? {
        stdout: `[ro.build.version.sdk]: [${level}]\n[sys.boot_completed]: [1]\n`,
      }
    : recorded(`api-${level}/device/getprop.txt`)
}

/** Settings in front, landscape-left, 2400 × 1080 px. */
function setup(
  answer: (script: string) => FakeRun,
  {
    level = 36,
    serial = EMULATOR,
    runs = {},
  }: {
    level?: number
    serial?: string
    runs?: Record<string, FakeRun | FakeRun[]>
  } = {},
) {
  const api = `api-${level}`
  const adb = `adb -s ${serial}`
  const base = byCommand({
    'adb devices -l': devicesOf(serial, level),
    [`${adb} shell getprop`]: propsOf(serial, level),
    [`${adb} shell dumpsys window displays`]: recorded(
      `${api}/none/rotation-1/settings/dumpsys-window-displays.txt`,
    ),
    ...runs,
  })
  // `scripts` splits each script into its lines, which is right for every
  // line but the `if` of a guarded shot: `raw` keeps that one whole.
  const raw: string[] = []
  const scripts: string[][] = []
  const sent: string[][] = []
  const { context, calls } = fakeContext((call) => {
    if (call.args.includes('emu')) {
      sent.push(call.args.slice(call.args.indexOf('send') + 1))
      return recorded('api-36/touch/console/event-down.txt')
    }
    const script = call.args.at(-1) ?? ''
    if (!script.includes('loupe-stamp')) return base(call)
    raw.push(script)
    scripts.push(script.split('; '))
    return answer(script)
  })
  return {
    calls,
    raw,
    scripts,
    sent,
    target: () => selectAndroidDevice(context),
  }
}

/** The recorded Settings screens are landscape-left, 2400 × 1080 px. */
const LANDSCAPE = {
  orientation: 'landscape-left' as const,
  pixels: { width: 2400, height: 1080 },
}

function finger(x: number, y: number) {
  return [toRaw({ x, y }, LANDSCAPE)]
}

/** The output of a script: one stamp line for each name, at ms from 0. */
function stamps(times: Record<string, number>, ...lines: string[]): FakeRun {
  const stampLines = Object.entries(times).map(
    ([name, ms]) =>
      `loupe-stamp ${name} ${(1_700_000_000 + ms / 1000).toFixed(6)}`,
  )
  return { stdout: [...lines, ...stampLines].join('\n') + '\n' }
}

function ran(calls: readonly FakeCall[], word: string): boolean {
  return calls.some((call) => call.args.includes(word))
}

describe('doubleTapAndroid', () => {
  it('taps twice in one script on an emulator over TCP, and gives the gap between the taps', async () => {
    const { scripts, target } = setup(() => stamps({ first: 0, second: 117 }), {
      serial: TCP,
    })

    expect(await doubleTapAndroid(await target(), { x: 100, y: 200 })).toEqual({
      orientation: 'landscape-left',
      points: [{ x: 100, y: 200 }],
      pixels: [{ x: 263, y: 525 }],
      gap: 117,
    })
    expect(scripts).toEqual([
      [
        'input tap 263 525 || echo loupe-failed',
        'echo "loupe-stamp first $EPOCHREALTIME"',
        'sleep 0.100',
        'input tap 263 525 || echo loupe-failed',
        'echo "loupe-stamp second $EPOCHREALTIME"',
      ],
    ])
  })

  it('fails with timeout when the taps were too far apart', async () => {
    const { target } = setup(() => stamps({ first: 0, second: 412 }), {
      serial: TCP,
    })

    await expect(
      doubleTapAndroid(await target(), { x: 100, y: 200 }),
    ).rejects.toMatchObject({
      code: 'timeout',
      message:
        'The two taps were 412 ms apart, more than the 300 ms of a double-tap, so the app saw two taps.',
    })
  })

  it('fails when the pause did not work', async () => {
    const { target } = setup(() => stamps({ first: 0, second: 15 }), {
      serial: TCP,
    })

    await expect(
      doubleTapAndroid(await target(), { x: 100, y: 200 }),
    ).rejects.toMatchObject({ code: 'tool_failed' })
  })

  it('fails when an input call failed, or the stamps are missing', async () => {
    const failed = setup(
      () => stamps({ first: 0, second: 117 }, 'loupe-failed'),
      { serial: TCP },
    )
    const noStamps = setup(() => ({ stdout: 'loupe-stamp first \n' }), {
      serial: TCP,
    })

    await expect(
      doubleTapAndroid(await failed.target(), { x: 100, y: 200 }),
    ).rejects.toMatchObject({ code: 'tool_failed' })
    await expect(
      doubleTapAndroid(await noStamps.target(), { x: 100, y: 200 }),
    ).rejects.toMatchObject({
      code: 'tool_failed',
      message:
        "loupe can't read the time stamps of the gesture from the device.",
    })
  })

  it.each([30, 36])(
    'taps twice through the console on an API %i emulator',
    async (level) => {
      const { scripts, sent, target } = setup(() => stamps({}), { level })

      const tap = await doubleTapAndroid(await target(), { x: 100, y: 200 })

      expect(finger(263, 525)).toEqual([{ x: 16839, y: 3590 }])
      expect(sent).toEqual([
        downEvents(finger(263, 525)),
        upEvents(1),
        downEvents(finger(263, 525)),
        upEvents(1),
      ])
      expect(tap).toMatchObject({
        orientation: 'landscape-left',
        pixels: [{ x: 263, y: 525 }],
      })
      expect(tap.gap).toBeGreaterThanOrEqual(99)
      expect(scripts).toEqual([])
    },
  )

  it('taps twice in one script on a real device with API 36', async () => {
    const { scripts, sent, target } = setup(
      () => stamps({ first: 0, second: 117 }),
      { serial: PHONE },
    )

    const tap = await doubleTapAndroid(
      await target(),
      { x: 100, y: 200 },
      SETTINGS,
    )

    expect(tap.gap).toBe(117)
    expect(scripts[0]?.[0]).toBe('input tap 263 525 || echo loupe-failed')
    expect(sent).toEqual([])
  })

  it('is unsupported on a real device with API 30, and touches nothing', async () => {
    const { calls, target } = setup(() => stamps({}), {
      level: 30,
      serial: PHONE,
    })

    await expect(
      doubleTapAndroid(await target(), { x: 100, y: 200 }, 'com.example.app'),
    ).rejects.toMatchObject({
      code: 'unsupported',
      message:
        'A double-tap on API level 30 works only on an emulator: it goes through the emulator console, and PHONE123 is a real device.',
    })
    expect(ran(calls, 'dumpsys')).toBe(false)
  })

  it('is unsupported on an API 30 emulator over TCP', async () => {
    const { target } = setup(() => stamps({}), { level: 30, serial: TCP })

    await expect(
      doubleTapAndroid(await target(), { x: 100, y: 200 }),
    ).rejects.toMatchObject({
      code: 'unsupported',
      message:
        'A double-tap on API level 30 goes through the emulator console, and adb reaches it only for a serial like emulator-5554, not 127.0.0.1:5555.',
    })
  })

  it('touches nothing while another app is in front', async () => {
    const { scripts, sent, target } = setup(() => stamps({}))

    await expect(
      doubleTapAndroid(await target(), { x: 100, y: 200 }, 'com.example.app'),
    ).rejects.toMatchObject({ code: 'app_not_in_front' })
    expect(sent).toEqual([])
    expect(scripts).toEqual([])
  })
})

describe('dragAndroid', () => {
  it('sends DOWN, 10 MOVE steps with pauses, and UP, in one script on an emulator over TCP', async () => {
    const { scripts, target } = setup(() => stamps({ move: 0, moved: 412 }), {
      serial: TCP,
    })

    const drag = await dragAndroid(
      await target(),
      { x: 100, y: 100 },
      { x: 100, y: 300 },
      DRAG,
    )

    expect(drag).toEqual({
      orientation: 'landscape-left',
      points: [
        { x: 100, y: 100 },
        { x: 100, y: 300 },
      ],
      pixels: [
        { x: 263, y: 263 },
        { x: 263, y: 788 },
      ],
      duration: 300,
      holdStart: 0,
      holdEnd: 0,
      moveTime: 412,
    })
    const [script = []] = scripts
    expect(script[0]).toBe(
      'input motionevent DOWN 263 263 || echo loupe-failed',
    )
    expect(script[1]).toBe('echo "loupe-stamp move $EPOCHREALTIME"')
    expect(script.filter((line) => line.includes('MOVE'))).toEqual(
      [316, 368, 421, 473, 526, 578, 631, 683, 736, 788].map(
        (y) => `input motionevent MOVE 263 ${y} || echo loupe-failed`,
      ),
    )
    expect(script.filter((line) => line === 'sleep 0.030')).toHaveLength(10)
    expect(script.slice(-2)).toEqual([
      'echo "loupe-stamp moved $EPOCHREALTIME"',
      'input motionevent UP 263 788 || echo loupe-failed',
    ])
  })

  it('holds at the start and at the end, and takes the shot after the end hold', async () => {
    const png = pngHeader(2400, 1080)
    const { calls, scripts, target } = setup(
      () => stamps({ move: 0, moved: 300 }, 'loupe-shot'),
      {
        serial: TCP,
        runs: {
          [`${TCP_ADB} exec-out cat ${SHOT}`]: { stdout: png },
          [`${TCP_ADB} shell rm -f ${SHOT}`]: {},
        },
      },
    )

    const drag = await dragAndroid(
      await target(),
      { x: 100, y: 100 },
      { x: 100, y: 300 },
      { duration: 0, holdStart: 500, holdEnd: 800, shotAt: 1 },
    )

    expect(drag.png).toEqual(png)
    expect(scripts[0]).toEqual([
      'input motionevent DOWN 263 263 || echo loupe-failed',
      'sleep 0.500',
      'echo "loupe-stamp move $EPOCHREALTIME"',
      ...[316, 368, 421, 473, 526, 578, 631, 683, 736, 788].map(
        (y) => `input motionevent MOVE 263 ${y} || echo loupe-failed`,
      ),
      'echo "loupe-stamp moved $EPOCHREALTIME"',
      'sleep 0.800',
      `screencap -p ${SHOT} && echo loupe-shot`,
      'input motionevent UP 263 788 || echo loupe-failed',
    ])
    expect(calls.at(-1)?.args.join(' ')).toBe(`-s ${TCP} shell rm -f ${SHOT}`)
  })

  it.each([
    [0, 1],
    [0.5, 7],
    [0.96, 12],
  ])('takes the shot at %d of the move', async (shotAt, line) => {
    const { scripts, target } = setup(
      () => stamps({ move: 0, moved: 300 }, 'loupe-shot'),
      {
        serial: TCP,
        runs: {
          [`${TCP_ADB} exec-out cat ${SHOT}`]: {
            stdout: pngHeader(2400, 1080),
          },
          [`${TCP_ADB} shell rm -f ${SHOT}`]: {},
        },
      },
    )

    await dragAndroid(
      await target(),
      { x: 100, y: 100 },
      { x: 100, y: 300 },
      { ...DRAG, duration: 0, shotAt },
    )

    const script = scripts[0] ?? []
    expect(script.findIndex((line) => line.startsWith('screencap'))).toBe(line)
  })

  it('checks the focus right before the shot on a real device', async () => {
    const { raw, target } = setup(
      () => stamps({ move: 0, moved: 300 }, 'loupe-shot'),
      {
        serial: PHONE,
        runs: {
          [`adb -s ${PHONE} exec-out cat ${SHOT}`]: {
            stdout: pngHeader(2400, 1080),
          },
          [`adb -s ${PHONE} shell rm -f ${SHOT}`]: {},
        },
      },
    )

    await dragAndroid(
      await target(),
      { x: 100, y: 100 },
      { x: 100, y: 300 },
      { ...DRAG, shotAt: 1 },
      SETTINGS,
    )

    expect(raw[0]).toContain(
      `; if dumpsys window displays | grep -m 1 mCurrentFocus= | grep -q 'u[0-9]* com\\.android\\.settings[/}]'; then screencap -p ${SHOT} && echo loupe-shot; else echo loupe-not-in-front; fi; input motionevent UP 263 788 || echo loupe-failed`,
    )
  })

  it('gives no shot, and deletes the file, when the focus moved away', async () => {
    const { calls, target } = setup(
      () => stamps({ move: 0, moved: 300 }, 'loupe-not-in-front'),
      { serial: PHONE, runs: { [`adb -s ${PHONE} shell rm -f ${SHOT}`]: {} } },
    )

    await expect(
      dragAndroid(
        await target(),
        { x: 100, y: 100 },
        { x: 100, y: 300 },
        { ...DRAG, shotAt: 1 },
        SETTINGS,
      ),
    ).rejects.toMatchObject({ code: 'app_not_in_front' })
    expect(ran(calls, 'cat')).toBe(false)
    expect(ran(calls, 'rm')).toBe(true)
  })

  it('fails when screencap failed, or gave no PNG', async () => {
    const noShot = setup(() => stamps({ move: 0, moved: 300 }), {
      serial: TCP,
      runs: { [`${TCP_ADB} shell rm -f ${SHOT}`]: {} },
    })
    const notPng = setup(() => stamps({ move: 0, moved: 300 }, 'loupe-shot'), {
      serial: TCP,
      runs: {
        [`${TCP_ADB} exec-out cat ${SHOT}`]: { stdout: 'cat: no such file' },
        [`${TCP_ADB} shell rm -f ${SHOT}`]: {},
      },
    })
    const drag = async (target: AndroidTarget) =>
      dragAndroid(
        target,
        { x: 100, y: 100 },
        { x: 100, y: 300 },
        {
          ...DRAG,
          shotAt: 1,
        },
      )

    await expect(drag(await noShot.target())).rejects.toMatchObject({
      code: 'tool_failed',
      message: `screencap failed on ${TCP} during the drag.`,
    })
    await expect(drag(await notPng.target())).rejects.toMatchObject({
      code: 'tool_failed',
      message: `The screenshot of the drag on ${TCP} isn't a PNG.`,
    })
  })

  it.each([30, 36])(
    'drags through the console on an API %i emulator',
    async (level) => {
      const { scripts, sent, target } = setup(() => stamps({}), { level })

      const drag = await dragAndroid(
        await target(),
        { x: 100, y: 100 },
        { x: 100, y: 300 },
        { duration: 50, holdStart: 0, holdEnd: 0 },
      )

      expect(sent).toHaveLength(12)
      expect(sent[0]).toEqual(downEvents(finger(263, 263)))
      expect(sent[1]).toEqual(moveEvents(finger(263, 316)))
      expect(sent[10]).toEqual(moveEvents(finger(263, 788)))
      expect(sent[11]).toEqual(upEvents(1))
      expect(drag).toMatchObject({
        pixels: [
          { x: 263, y: 263 },
          { x: 263, y: 788 },
        ],
        png: undefined,
      })
      expect(drag.moveTime).toBeGreaterThanOrEqual(49)
      expect(scripts).toEqual([])
    },
  )

  it('takes the shot from the host while the finger is down', async () => {
    const { calls, target } = setup(() => stamps({}), {
      runs: {
        [`${ADB} exec-out screencap -p`]: { stdout: pngHeader(2400, 1080) },
      },
    })

    const drag = await dragAndroid(
      await target(),
      { x: 100, y: 100 },
      { x: 100, y: 300 },
      { duration: 0, holdStart: 0, holdEnd: 0, shotAt: 0.5 },
      SETTINGS,
    )

    const touch = calls.findIndex((call) => call.args.includes('emu'))
    const order = calls.slice(touch).map((call) => {
      if (call.args.includes('screencap')) return 'shot'
      if (call.args.includes('dumpsys')) return 'focus'
      return call.args.includes('EV_KEY:BTN_TOUCH:0') ? 'up' : 'touch'
    })
    expect(order).toEqual([
      ...Array<string>(6).fill('touch'),
      'focus',
      'shot',
      ...Array<string>(5).fill('touch'),
      'up',
    ])
    expect(drag.png).toEqual(pngHeader(2400, 1080))
  })

  it('ends the drag, then fails, when the focus moved away before the shot, on API 30', async () => {
    const { calls, sent, target } = setup(() => stamps({}), {
      level: 30,
      runs: {
        [`${ADB} shell dumpsys window displays`]: [
          recorded(
            'api-30/none/rotation-1/settings/dumpsys-window-displays.txt',
          ),
          recorded('api-30/none/rotation-1/home/dumpsys-window-displays.txt'),
        ],
      },
    })

    await expect(
      dragAndroid(
        await target(),
        { x: 100, y: 100 },
        { x: 100, y: 300 },
        { duration: 0, holdStart: 0, holdEnd: 0, shotAt: 0.5 },
        SETTINGS,
      ),
    ).rejects.toMatchObject({ code: 'app_not_in_front' })
    expect(sent).toHaveLength(12)
    expect(sent.at(-1)).toEqual(upEvents(1))
    expect(ran(calls, 'screencap')).toBe(false)
  })

  it('is unsupported on a real device with API 30', async () => {
    const { target } = setup(() => stamps({}), { level: 30, serial: PHONE })

    await expect(
      dragAndroid(
        await target(),
        { x: 100, y: 100 },
        { x: 100, y: 300 },
        DRAG,
        'com.example.app',
      ),
    ).rejects.toMatchObject({ code: 'unsupported' })
  })

  it('refuses an end point off the screen, and touches nothing', async () => {
    const { sent, target } = setup(() => stamps({}))

    await expect(
      dragAndroid(await target(), { x: 100, y: 100 }, { x: 100, y: 500 }, DRAG),
    ).rejects.toMatchObject({ code: 'invalid_input' })
    expect(sent).toEqual([])
  })
})
