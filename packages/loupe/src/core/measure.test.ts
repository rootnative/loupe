import { describe, expect, it } from 'vitest'
import {
  colourRuns,
  describeRun,
  joinShortRuns,
  measureFrame,
  measureTargetOf,
  type PixelRun,
  runInDp,
} from './measure'
import { type Image } from './png'

/** One row of pixels, from RGBA tuples. */
function row(...pixels: number[][]): Image {
  return {
    width: pixels.length,
    height: 1,
    data: new Uint8Array(pixels.flat()),
  }
}

const RED = [255, 0, 0, 255]
const BLUE = [0, 0, 255, 255]

describe('measureTargetOf', () => {
  it.each([
    [{ row: 10 }, { line: { axis: 'row', at: 10 } }],
    [{ column: 0 }, { line: { axis: 'column', at: 0 } }],
    [{ text: 'Title' }, { selector: { by: 'text', value: 'Title' } }],
    [{ label: 'Close' }, { selector: { by: 'label', value: 'Close' } }],
    [{ id: 'title' }, { selector: { by: 'id', value: 'title' } }],
  ])('takes %j', (input, target) => {
    expect(measureTargetOf(input)).toEqual(target)
  })

  it.each([[{}], [{ row: 1, column: 2 }], [{ row: 1, text: 'Title' }]])(
    'needs exactly one target: %j',
    (input) => {
      expect(() => measureTargetOf(input)).toThrow(
        expect.objectContaining({ code: 'invalid_input' }),
      )
    },
  )
})

describe('colourRuns', () => {
  it('gives one run for each colour, covering the line', () => {
    expect(colourRuns(row(RED, RED, BLUE, RED), 'row', 0, 0)).toEqual([
      { start: 0, end: 2, colour: '#ff0000' },
      { start: 2, end: 3, colour: '#0000ff' },
      { start: 3, end: 4, colour: '#ff0000' },
    ])
  })

  it("keeps a pixel in the run within the tolerance of the run's first pixel, and gives the mean", () => {
    const image = row(
      [100, 0, 0, 255],
      [104, 0, 0, 255],
      [108, 0, 0, 255],
      [109, 0, 0, 255],
    )

    expect(colourRuns(image, 'row', 0, 8)).toEqual([
      { start: 0, end: 3, colour: '#680000' },
      { start: 3, end: 4, colour: '#6d0000' },
    ])
  })

  it('writes the alpha when the run is not opaque', () => {
    expect(colourRuns(row([1, 2, 3, 128]), 'row', 0, 0)).toEqual([
      { start: 0, end: 1, colour: '#01020380' },
    ])
  })

  it('reads a column of the image', () => {
    // 2 × 3 px: the left column is red, red, blue.
    const image: Image = {
      width: 2,
      height: 3,
      data: new Uint8Array([RED, BLUE, RED, BLUE, BLUE, BLUE].flat()),
    }

    expect(colourRuns(image, 'column', 0, 0)).toEqual([
      { start: 0, end: 2, colour: '#ff0000' },
      { start: 2, end: 3, colour: '#0000ff' },
    ])
  })
})

describe('joinShortRuns', () => {
  const run = (start: number, end: number, colour = '#000000'): PixelRun => ({
    start,
    end,
    colour,
  })

  it('joins two or more short runs in a row into one with no colour', () => {
    expect(
      joinShortRuns(
        [run(0, 10), run(10, 11), run(11, 12), run(12, 13), run(13, 30)],
        3,
      ),
    ).toEqual([run(0, 10), { start: 10, end: 13 }, run(13, 30)])
  })

  it('keeps a short run alone with its colour, as a thin line', () => {
    expect(
      joinShortRuns([run(0, 10), run(10, 11, '#ffffff'), run(11, 30)], 3),
    ).toEqual([run(0, 10), run(10, 11, '#ffffff'), run(11, 30)])
  })

  it('joins short runs at both ends of the line, and keeps each run at 0', () => {
    const runs = [run(0, 1), run(1, 2), run(2, 20), run(20, 21), run(21, 22)]

    expect(joinShortRuns(runs, 3)).toEqual([
      { start: 0, end: 2 },
      run(2, 20),
      { start: 20, end: 22 },
    ])
    expect(joinShortRuns(runs, 0)).toEqual(runs)
  })
})

describe('runInDp and describeRun', () => {
  it('gives the run in dp and px, and one line for a person', () => {
    const run = runInDp({ start: 0, end: 136, colour: '#e76f51' }, 2.625)

    expect(run).toEqual({
      from: 0,
      to: 136 / 2.625,
      length: 136 / 2.625,
      pixels: { from: 0, to: 136 },
      colour: '#e76f51',
    })
    expect(describeRun(run)).toBe('0–51.81 dp (51.81 dp): #e76f51')
    expect(describeRun({ ...run, colour: undefined })).toBe(
      '0–51.81 dp (51.81 dp): mixed',
    )
  })
})

describe('measureFrame', () => {
  const screen = { width: 900, height: 400 }
  const safeArea = { top: 24, right: 0, bottom: 24, left: 50 }

  it('gives the distance to each edge of the screen and of the safe area', () => {
    expect(
      measureFrame({ x: 40, y: 10, width: 100, height: 20 }, screen, safeArea),
    ).toEqual({
      toScreen: { top: 10, right: 760, bottom: 370, left: 40 },
      toSafeArea: { top: -14, right: 760, bottom: 346, left: -10 },
      offCentre: {
        screen: { x: -360, y: -180 },
        safeArea: { x: -385, y: -180 },
      },
    })
  })

  it('gives 0 off the screen centre for an element centred on the screen', () => {
    const frame = { x: 425, y: 190, width: 50, height: 20 }

    expect(measureFrame(frame, screen, safeArea).offCentre).toEqual({
      screen: { x: 0, y: 0 },
      safeArea: { x: -25, y: 0 },
    })
  })
})
