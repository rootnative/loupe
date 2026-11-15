import { describe, expect, it } from 'vitest'
import { orientationOf } from '../../core/display'
import { byCommand, type FakeRun, fakeContext } from '../../testing/fake-exec'
import { recorded, recordedText } from '../../testing/fixtures'
import { createAdb } from './adb'
import {
  consoleGesture,
  downEvents,
  moveEvents,
  needsConsole,
  toRaw,
  upEvents,
  whileDown,
} from './console'
import { type AndroidTarget } from './devices'

const SERIAL = 'emulator-5554'
const OK = recorded('api-36/touch/console/event-down.txt')

function emulator(replies: FakeRun[] = [OK]) {
  const sent: string[][] = []
  let index = 0
  const { context } = fakeContext(({ args }) => {
    if (args.slice(0, 5).join(' ') !== `-s ${SERIAL} emu event send`) {
      return undefined
    }
    sent.push(args.slice(5))
    return replies[Math.min(index++, replies.length - 1)]
  })
  const target: AndroidTarget = {
    serial: SERIAL,
    kind: 'emulator',
    apiLevel: 30,
    adb: createAdb(context).forDevice(SERIAL),
  }
  return { target, sent }
}

function errorOf(action: () => unknown): unknown {
  try {
    action()
  } catch (error) {
    return error
  }
  throw new Error('No error')
}

describe('toRaw', () => {
  // Round 4 of the recorder sent these raw units in a pinch, and Android put
  // both fingers on the planned px on all 5 API levels.
  it.each([0, 1, 3])(
    'gives the units that landed in rotation %i',
    (rotation) => {
      const pixels =
        rotation % 2 === 0
          ? { width: 1080, height: 2400 }
          : { width: 2400, height: 1080 }
      const display = { orientation: orientationOf(rotation), pixels }
      const lines = recordedText(
        `api-36/touch/pinch/rotation-${rotation}/points.txt`,
      )
        .trim()
        .split('\n')

      for (const line of lines) {
        const [x1, y1, x2, y2, raw1x, raw1y, raw2x, raw2y] =
          (line.split(':')[1] ?? '').match(/\d+/g)?.map(Number) ?? []
        expect([
          toRaw({ x: x1 ?? -1, y: y1 ?? -1 }, display),
          toRaw({ x: x2 ?? -1, y: y2 ?? -1 }, display),
        ]).toEqual([
          { x: raw1x, y: raw1y },
          { x: raw2x, y: raw2y },
        ])
      }
      expect(lines).toHaveLength(11)
    },
  )

  // From the Android source; no recording turns the screen upside down.
  it('turns a point half a turn in portrait-upside-down', () => {
    const display = {
      orientation: orientationOf(2),
      pixels: { width: 1080, height: 2400 },
    }

    expect(toRaw({ x: 1080 / 4, y: 2400 / 4 }, display)).toEqual({
      x: 24576,
      y: 24576,
    })
  })

  it('keeps a point on the last px inside the units', () => {
    const display = {
      orientation: orientationOf(1),
      pixels: { width: 2400, height: 1080 },
    }

    expect(toRaw({ x: 2399.99, y: 0 }, display)).toEqual({
      x: 32767,
      y: 32767,
    })
  })
})

describe('the events', () => {
  it('put two fingers down, move them and lift them, one slot each', () => {
    const fingers = [
      { x: 1, y: 2 },
      { x: 3, y: 4 },
    ]

    expect(downEvents(fingers)).toEqual([
      'EV_ABS:ABS_MT_SLOT:0',
      'EV_ABS:ABS_MT_TRACKING_ID:1',
      'EV_ABS:ABS_MT_POSITION_X:1',
      'EV_ABS:ABS_MT_POSITION_Y:2',
      'EV_ABS:ABS_MT_PRESSURE:50',
      'EV_ABS:ABS_MT_SLOT:1',
      'EV_ABS:ABS_MT_TRACKING_ID:2',
      'EV_ABS:ABS_MT_POSITION_X:3',
      'EV_ABS:ABS_MT_POSITION_Y:4',
      'EV_ABS:ABS_MT_PRESSURE:50',
      'EV_KEY:BTN_TOUCH:1',
      'EV_SYN:0:0',
    ])
    expect(moveEvents(fingers)).toEqual([
      'EV_ABS:ABS_MT_SLOT:0',
      'EV_ABS:ABS_MT_POSITION_X:1',
      'EV_ABS:ABS_MT_POSITION_Y:2',
      'EV_ABS:ABS_MT_SLOT:1',
      'EV_ABS:ABS_MT_POSITION_X:3',
      'EV_ABS:ABS_MT_POSITION_Y:4',
      'EV_SYN:0:0',
    ])
    expect(upEvents(2)).toEqual([
      'EV_ABS:ABS_MT_SLOT:0',
      'EV_ABS:ABS_MT_TRACKING_ID:-1',
      'EV_ABS:ABS_MT_SLOT:1',
      'EV_ABS:ABS_MT_TRACKING_ID:-1',
      'EV_KEY:BTN_TOUCH:0',
      'EV_SYN:0:0',
    ])
  })
})

describe('consoleGesture', () => {
  const steps = [
    [
      { x: 10, y: 20 },
      { x: 30, y: 40 },
    ],
    [
      { x: 11, y: 21 },
      { x: 31, y: 41 },
    ],
    [
      { x: 12, y: 22 },
      { x: 32, y: 42 },
    ],
  ]

  it('sends a touch, one call for each step, and a lift', async () => {
    const { target, sent } = emulator()

    const moveTime = await consoleGesture(target, steps, 0)

    expect(sent).toEqual([
      downEvents(steps[0] ?? []),
      moveEvents(steps[1] ?? []),
      moveEvents(steps[2] ?? []),
      upEvents(2),
    ])
    expect(moveTime).toBeGreaterThanOrEqual(0)
  })

  it('waits between the steps', async () => {
    const { target } = emulator()

    expect(await consoleGesture(target, steps, 20)).toBeGreaterThanOrEqual(39)
  })

  // adb exits with 0 when the console refuses an event.
  it('fails on a refused event, and still lifts the fingers', async () => {
    const { target, sent } = emulator([
      OK,
      recorded('api-36/touch/console/event-unknown.txt'),
      OK,
    ])

    const failure = consoleGesture(target, steps, 0)

    await expect(failure).rejects.toMatchObject({
      code: 'tool_failed',
      message: expect.stringContaining('KO: invalid event code'),
    })
    expect(sent).toEqual([
      downEvents(steps[0] ?? []),
      moveEvents(steps[1] ?? []),
      upEvents(2),
    ])
  })

  it('keeps the error of the step when the lift fails too', async () => {
    const { target } = emulator([
      recorded('api-36/touch/console/no-emulator.txt'),
    ])

    await expect(consoleGesture(target, steps, 0)).rejects.toMatchObject({
      code: 'tool_failed',
      message: expect.stringContaining('could not connect to TCP port'),
    })
  })

  it('fails when the lift fails', async () => {
    const { target } = emulator([
      OK,
      OK,
      OK,
      recorded('api-36/touch/console/event-unknown.txt'),
    ])

    await expect(consoleGesture(target, steps, 0)).rejects.toMatchObject({
      code: 'tool_failed',
    })
  })
})

describe('whileDown', () => {
  const fingers = [{ x: 10, y: 20 }]

  it('gives the value of the body, between the touch and the lift', async () => {
    const { target, sent } = emulator()

    const value = await whileDown(target, fingers, async (move) => {
      await move([{ x: 11, y: 21 }])
      return sent.length
    })

    expect(value).toBe(2)
    expect(sent).toEqual([
      downEvents(fingers),
      moveEvents([{ x: 11, y: 21 }]),
      upEvents(1),
    ])
  })

  it('lifts the finger when the body fails', async () => {
    const { target, sent } = emulator()

    await expect(
      whileDown(target, fingers, () => Promise.reject(new Error('body'))),
    ).rejects.toThrow('body')
    expect(sent).toEqual([downEvents(fingers), upEvents(1)])
  })
})

describe('needsConsole', () => {
  const target = (serial: string, kind: AndroidTarget['kind']) => ({
    serial,
    kind,
    apiLevel: 36,
    adb: createAdb(fakeContext(byCommand({})).context).forDevice(serial),
  })

  it('takes an emulator with a console port in its serial', () => {
    expect(() =>
      needsConsole(target(SERIAL, 'emulator'), 'A pinch'),
    ).not.toThrow()
  })

  it.each([
    ['a real device', target('PHONE123', 'device'), 'is a real device'],
    [
      'an emulator over TCP',
      target('127.0.0.1:5555', 'emulator'),
      'a serial like emulator-5554',
    ],
  ])('refuses %s', (_name, input, message) => {
    expect(errorOf(() => needsConsole(input, 'A pinch'))).toMatchObject({
      code: 'unsupported',
      message: expect.stringContaining(message),
    })
  })
})
