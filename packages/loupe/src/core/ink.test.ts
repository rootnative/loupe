import { describe, expect, it } from 'vitest'
import { inkColumns } from './ink'
import { type Image, type PixelRect } from './png'

type Colour = readonly [number, number, number]

const BAR: Colour = [0xd9, 0xe2, 0xec]
const INK: Colour = [0, 0, 0]

function image(width: number, height: number, colour: Colour): Image {
  const data = new Uint8Array(width * height * 4)
  for (let index = 0; index < data.length; index += 4) {
    data.set([...colour, 255], index)
  }
  return { width, height, data }
}

function paint(
  target: Image,
  { x, y, width, height }: PixelRect,
  colour: Colour,
) {
  for (let row = y; row < y + height; row += 1) {
    for (let column = x; column < x + width; column += 1) {
      target.data.set([...colour, 255], (row * target.width + column) * 4)
    }
  }
}

const WHOLE = { x: 0, y: 0, width: 100, height: 20 }

describe('inkColumns', () => {
  it('finds the columns of the ink inside a wide frame', () => {
    const shot = image(100, 20, BAR)
    paint(shot, { x: 40, y: 5, width: 20, height: 10 }, INK)

    expect(inkColumns(shot, WHOLE)).toEqual({ from: 40, to: 60 })
  })

  it('takes the commonest colour on the border as the background', () => {
    const shot = image(100, 20, BAR)
    paint(shot, { x: 30, y: 0, width: 20, height: 20 }, INK)

    expect(inkColumns(shot, WHOLE)).toEqual({ from: 30, to: 50 })
  })

  it('leaves out the soft edge of a glyph', () => {
    const shot = image(100, 20, [200, 200, 200])
    paint(shot, { x: 10, y: 5, width: 1, height: 1 }, [168, 200, 200])
    paint(shot, { x: 20, y: 5, width: 1, height: 1 }, [167, 200, 200])
    paint(shot, { x: 30, y: 5, width: 1, height: 1 }, [200, 200, 232])

    expect(inkColumns(shot, WHOLE)).toEqual({ from: 20, to: 21 })
  })

  it('leaves out the pixels under a mask: another element draws there', () => {
    const shot = image(100, 20, BAR)
    paint(shot, { x: 0, y: 2, width: 12, height: 16 }, [0x48, 0x65, 0x81])
    paint(shot, { x: 45, y: 5, width: 10, height: 10 }, INK)

    expect(inkColumns(shot, WHOLE)).toEqual({ from: 0, to: 55 })
    expect(
      inkColumns(shot, WHOLE, [{ x: 0, y: 2, width: 12, height: 16 }]),
    ).toEqual({ from: 45, to: 55 })
  })

  it('looks only inside the rect, and clamps it to the image', () => {
    const shot = image(100, 20, BAR)
    paint(shot, { x: 5, y: 5, width: 5, height: 5 }, INK)
    paint(shot, { x: 90, y: 5, width: 5, height: 5 }, INK)

    expect(inkColumns(shot, { x: 50, y: -10, width: 80, height: 40 })).toEqual({
      from: 90,
      to: 95,
    })
  })

  it('gives null with no ink, with each border pixel masked, or off the image', () => {
    const shot = image(100, 20, BAR)

    expect(inkColumns(shot, WHOLE)).toBeNull()
    expect(inkColumns(shot, WHOLE, [WHOLE])).toBeNull()
    expect(inkColumns(shot, { x: 100, y: 0, width: 10, height: 20 })).toBeNull()
  })
})
