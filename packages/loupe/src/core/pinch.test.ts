import { describe, expect, it } from 'vitest'
import { type Point } from './units'
import { describePinch, type PinchShape, planPinch } from './pinch'

const PORTRAIT = { width: 411.43, height: 914.29 }
const LANDSCAPE = { width: 914.29, height: 411.43 }

function shape(change: Partial<PinchShape> = {}): PinchShape {
  return {
    centre: { x: 200, y: 400 },
    scale: 2,
    distance: 200,
    turn: 0,
    ...change,
  }
}

function near([first, second]: [Point, Point]) {
  const close = ({ x, y }: Point) => ({
    x: expect.closeTo(x, 9),
    y: expect.closeTo(y, 9),
  })
  return [close(first), close(second)]
}

function errorOf(action: () => unknown): unknown {
  try {
    action()
  } catch (error) {
    return error
  }
  throw new Error('No error')
}

describe('planPinch', () => {
  it('lines the fingers up along the longer side of the screen', () => {
    const portrait = planPinch(shape(), PORTRAIT, 10)
    const landscape = planPinch(shape(), LANDSCAPE, 10)

    expect(portrait.angle).toBe(90)
    expect(portrait.steps[0]).toEqual(
      near([
        { x: 200, y: 300 },
        { x: 200, y: 500 },
      ]),
    )
    expect(landscape.angle).toBe(0)
    expect(landscape.steps[0]).toEqual(
      near([
        { x: 100, y: 400 },
        { x: 300, y: 400 },
      ]),
    )
  })

  it('spreads from the distance, and pinches down to it', () => {
    const spread = planPinch(shape({ scale: 2 }), PORTRAIT, 10)
    const pinch = planPinch(shape({ scale: 0.5 }), PORTRAIT, 10)

    expect(spread.span).toEqual({ from: 200, to: 400 })
    expect(spread.steps).toHaveLength(11)
    expect(spread.steps.at(-1)).toEqual(
      near([
        { x: 200, y: 200 },
        { x: 200, y: 600 },
      ]),
    )
    expect(pinch.span).toEqual({ from: 400, to: 200 })
    expect(pinch.steps[0]).toEqual(
      near([
        { x: 200, y: 200 },
        { x: 200, y: 600 },
      ]),
    )
  })

  it('turns the fingers clockwise at an even rate', () => {
    const { steps } = planPinch(
      shape({ centre: { x: 400, y: 200 }, scale: 1, angle: 0, turn: 90 }),
      LANDSCAPE,
      10,
    )
    const half = 100 / Math.SQRT2

    expect(steps[0]).toEqual(
      near([
        { x: 300, y: 200 },
        { x: 500, y: 200 },
      ]),
    )
    expect(steps[5]).toEqual(
      near([
        { x: 400 - half, y: 200 - half },
        { x: 400 + half, y: 200 + half },
      ]),
    )
    expect(steps[10]).toEqual(
      near([
        { x: 400, y: 100 },
        { x: 400, y: 300 },
      ]),
    )
  })

  it('takes the angle of the input', () => {
    expect(planPinch(shape({ angle: 45 }), PORTRAIT, 10).angle).toBe(45)
  })

  it('needs a scale other than 1 or a turn', () => {
    expect(
      errorOf(() => planPinch(shape({ scale: 1 }), PORTRAIT, 10)),
    ).toMatchObject({ code: 'invalid_input' })
  })

  it.each([
    [2, 'at the end'],
    [0.5, 'at the start'],
  ])('fails when a finger leaves the screen, at scale %d', (scale, when) => {
    // 200 dp from the left edge: a span of 410 dp leaves the screen, and the
    // 389.5 dp of the step before the end doesn't.
    const error = errorOf(() =>
      planPinch(shape({ scale, distance: 205, angle: 0 }), PORTRAIT, 10),
    )

    expect(error).toMatchObject({ code: 'invalid_input' })
    expect((error as Error).message).toContain(`leaves the screen ${when}`)
  })
})

describe('describePinch', () => {
  const pinch = {
    orientation: 'portrait' as const,
    centre: { x: 205.714, y: 457.143 },
    fingers: [],
    span: { from: 200, to: 400 },
    scale: 2,
    angle: 90,
    turn: 0,
    duration: 300,
    moveTime: 341,
  }

  it('gives the centre, the spans and the time', () => {
    expect(describePinch(pinch)).toBe(
      'Pinched (205.71, 457.14) dp in portrait: 200 → 400 dp apart; the move took 341 ms',
    )
  })

  it('names the element and the turn', () => {
    expect(
      describePinch({
        ...pinch,
        turn: -45,
        element: {
          type: 'android.widget.ImageView',
          label: 'Map',
          frame: { x: 0, y: 0, width: 411.43, height: 914.29 },
        },
      }),
    ).toBe(
      'Pinched label "Map" at (205.71, 457.14) dp in portrait: 200 → 400 dp apart, turned 45° counter-clockwise; the move took 341 ms',
    )
  })
})
