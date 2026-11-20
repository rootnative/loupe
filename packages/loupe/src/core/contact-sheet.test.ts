import { describe, expect, it } from 'vitest'
import { recorded } from '../testing/fixtures'
import { contactSheet } from './contact-sheet'
import { decodePng, encodePng, type Image } from './png'

const BACKGROUND = [32, 32, 32, 255]
const FRAME = [117, 117, 117, 255]
const FAILED = [211, 47, 47, 255]
const BADGE = [0, 0, 0, 255]
const DIGIT = [255, 255, 255, 255]

function solid(width: number, height: number, colour: number[]): Image {
  const data = new Uint8Array(width * height * 4)
  for (let at = 0; at < data.length; at += 4) data.set(colour, at)
  return { width, height, data }
}

function pixel(image: Image, x: number, y: number): number[] {
  return [...image.data.subarray((y * image.width + x) * 4).subarray(0, 4)]
}

const BLUE = [0, 0, 255, 255]

describe('contactSheet', () => {
  it('puts the cells in rows, with a gap and a frame around each', () => {
    const cells = [1, 2, 3].map((number) => ({
      number,
      image: solid(480, 960, BLUE),
    }))
    const sheet = contactSheet(cells, { columns: 2 })

    // 240 × 480 thumbnails, a 4 px frame, 8 px gaps: 2 columns, 2 rows.
    expect([sheet.width, sheet.height]).toEqual([
      8 + 2 * (248 + 8),
      8 + 2 * (488 + 8),
    ])
    expect(pixel(sheet, 0, 0)).toEqual(BACKGROUND)
    expect(pixel(sheet, 8 + 247, 8 + 487)).toEqual(FRAME)
    expect(pixel(sheet, 8 + 4 + 120, 8 + 4 + 240)).toEqual(BLUE)
    // The second column, and the third cell in the second row.
    expect(pixel(sheet, 264 + 4 + 120, 8 + 4 + 240)).toEqual(BLUE)
    expect(pixel(sheet, 8 + 4 + 120, 504 + 4 + 240)).toEqual(BLUE)
    // No fourth cell.
    expect(pixel(sheet, 264 + 4 + 120, 504 + 4 + 240)).toEqual(BACKGROUND)
  })

  it('gives a failed cell a red frame and a red badge', () => {
    const sheet = contactSheet(
      [
        { number: 1, image: solid(240, 240, BLUE) },
        { number: 2, image: solid(240, 240, BLUE), failed: true },
      ],
      { columns: 2 },
    )

    expect(pixel(sheet, 8 + 247, 8 + 247)).toEqual(FRAME)
    expect(pixel(sheet, 8, 8)).toEqual(BADGE)
    expect(pixel(sheet, 264 + 247, 8 + 247)).toEqual(FAILED)
    expect(pixel(sheet, 264, 8)).toEqual(FAILED)
  })

  it('writes the number in the badge, in 3 px dots', () => {
    const sheet = contactSheet([{ number: 17, image: solid(240, 240, BLUE) }])
    // The dot of the font at a column and a row, for a digit of the badge.
    const dot = (digit: number, column: number, row: number) =>
      pixel(sheet, 8 + 4 + digit * 12 + column * 3 + 1, 8 + 4 + row * 3 + 1)
    const drawn = (digit: number) =>
      [0, 1, 2, 3, 4].map((row) =>
        [0, 1, 2]
          .map((column) =>
            dot(digit, column, row).join() === DIGIT.join() ? '#' : '.',
          )
          .join(''),
      )

    expect(drawn(0)).toEqual(['.#.', '##.', '.#.', '.#.', '###'])
    expect(drawn(1)).toEqual(['###', '..#', '..#', '..#', '..#'])
    // The badge ends after the second digit: 4 + 9 + 3 + 9 + 4 px wide.
    expect(pixel(sheet, 8 + 28, 8 + 22)).toEqual(BADGE)
    expect(pixel(sheet, 8 + 29, 8 + 23)).toEqual(BLUE)
  })

  it('takes as many columns as fit in the widest sheet', () => {
    const cells = Array.from({ length: 10 }, (_, index) => ({
      number: index + 1,
      image: solid(240, 100, BLUE),
    }))

    // 6 cells of 248 px with 8 px gaps are 1544 px; 7 are 1800 px.
    expect(contactSheet(cells).width).toBe(8 + 6 * 256)
    expect(contactSheet(cells, { maxWidth: 600 }).width).toBe(8 + 2 * 256)
    expect(contactSheet(cells, { maxWidth: 100 }).width).toBe(8 + 256)
    expect(contactSheet(cells.slice(0, 2)).width).toBe(8 + 2 * 256)
  })

  it("keeps a small screenshot's size, and the shape of a wide one", () => {
    const sheet = contactSheet([
      { number: 1, image: solid(100, 50, BLUE) },
      { number: 2, image: solid(2400, 1080, BLUE) },
    ])

    // The cell is as large as the largest thumbnail: 240 × 108.
    expect([sheet.width, sheet.height]).toEqual([8 + 2 * 256, 8 + 116 + 8])
    expect(pixel(sheet, 8 + 4 + 99, 8 + 4 + 49)).toEqual(BLUE)
    expect(pixel(sheet, 8 + 4 + 100 + 4, 8 + 4 + 49)).toEqual(BACKGROUND)
    expect(pixel(sheet, 264 + 4 + 239, 8 + 4 + 107)).toEqual(BLUE)
  })

  it('refuses no cells, and a number that the font cannot write', () => {
    const image = solid(10, 10, BLUE)

    expect(() => contactSheet([])).toThrow(RangeError)
    expect(() => contactSheet([{ number: -1, image }])).toThrow(RangeError)
    expect(() => contactSheet([{ number: 1.5, image }])).toThrow(RangeError)
  })

  it('makes a sheet of recorded screenshots that the codec reads back', () => {
    const shot = (name: string) =>
      decodePng(
        recorded(`api-36/check/ltr/rotation-0/${name}.png`).stdout as Buffer,
      )
    const sheet = contactSheet([
      { number: 1, image: shot('centred-defect'), failed: true },
      { number: 2, image: shot('centred-fixed') },
    ])
    const back = decodePng(encodePng(sheet))

    // 1080 × 2400 screenshots: 240 × 533 thumbnails.
    expect([back.width, back.height]).toEqual([8 + 2 * 256, 8 + 541 + 8])
    expect(Buffer.from(back.data).equals(Buffer.from(sheet.data))).toBe(true)
    expect(pixel(back, 8 + 247, 8 + 540)).toEqual(FAILED)
    expect(pixel(back, 264 + 247, 8 + 540)).toEqual(FRAME)
  })
})
