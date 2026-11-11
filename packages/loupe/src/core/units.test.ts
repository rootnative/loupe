import { describe, expect, it } from 'vitest'
import {
  containsRect,
  fromPixels,
  insetRect,
  intersection,
  pointToPixels,
  rectCentre,
  rectFromPixels,
  toPixels,
  unitOf,
} from './units'

describe('unitOf', () => {
  it('gives pt for iOS and dp for Android', () => {
    expect(unitOf('ios')).toBe('pt')
    expect(unitOf('android')).toBe('dp')
  })
})

describe('pixel conversion', () => {
  it('rounds to a whole pixel', () => {
    expect(toPixels(100, 3)).toBe(300)
    expect(toPixels(205.7, 2.625)).toBe(540)
    expect(pointToPixels({ x: 10.2, y: 20.6 }, 2)).toEqual({ x: 20, y: 41 })
  })

  it('keeps the fraction from pixels to points', () => {
    expect(fromPixels(1080, 2.625)).toBeCloseTo(411.43, 2)
    expect(fromPixels(1179, 3)).toBe(393)
  })

  it('converts each side of a rect', () => {
    expect(
      rectFromPixels({ x: 42, y: 84, width: 126, height: 168 }, 2),
    ).toEqual({ x: 21, y: 42, width: 63, height: 84 })
  })
})

describe('rectCentre', () => {
  it('gives the middle of the rect', () => {
    expect(rectCentre({ x: 10, y: 20, width: 100, height: 50 })).toEqual({
      x: 60,
      y: 45,
    })
  })
})

describe('containsRect', () => {
  const screen = { x: 0, y: 0, width: 400, height: 800 }

  it('accepts a rect inside, and one of the same size', () => {
    expect(
      containsRect(screen, { x: 10, y: 10, width: 100, height: 100 }),
    ).toBe(true)
    expect(containsRect(screen, screen)).toBe(true)
  })

  it('rejects a rect that runs past an edge', () => {
    expect(
      containsRect(screen, { x: 350, y: 10, width: 100, height: 100 }),
    ).toBe(false)
    expect(
      containsRect(screen, { x: -1, y: 10, width: 100, height: 100 }),
    ).toBe(false)
  })

  it('allows an overrun up to the tolerance', () => {
    const inner = { x: -0.4, y: 0, width: 400.8, height: 800 }

    expect(containsRect(screen, inner)).toBe(false)
    expect(containsRect(screen, inner, 0.5)).toBe(true)
  })
})

describe('intersection', () => {
  it('gives the shared area', () => {
    expect(
      intersection(
        { x: 0, y: 0, width: 100, height: 100 },
        { x: 60, y: 80, width: 100, height: 100 },
      ),
    ).toEqual({ x: 60, y: 80, width: 40, height: 20 })
  })

  it('gives null for rects that only touch or are apart', () => {
    const a = { x: 0, y: 0, width: 100, height: 100 }

    expect(intersection(a, { x: 100, y: 0, width: 50, height: 50 })).toBeNull()
    expect(
      intersection(a, { x: 200, y: 200, width: 50, height: 50 }),
    ).toBeNull()
  })
})

describe('insetRect', () => {
  it('removes the insets from the screen', () => {
    expect(
      insetRect(
        { width: 852, height: 393 },
        { top: 0, right: 59, bottom: 21, left: 59 },
      ),
    ).toEqual({ x: 59, y: 0, width: 734, height: 372 })
  })

  it('handles a one-sided inset', () => {
    expect(
      insetRect(
        { width: 900, height: 400 },
        { top: 24, right: 0, bottom: 0, left: 48 },
      ),
    ).toEqual({ x: 48, y: 24, width: 852, height: 376 })
  })

  it('never gives a negative size', () => {
    expect(
      insetRect(
        { width: 10, height: 10 },
        { top: 20, right: 20, bottom: 20, left: 20 },
      ),
    ).toEqual({ x: 20, y: 20, width: 0, height: 0 })
  })
})
