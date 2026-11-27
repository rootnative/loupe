import { crc32, deflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { recorded } from '../testing/fixtures'
import { pngHeader } from '../testing/png'
import {
  cropImage,
  decodePng,
  encodePng,
  type Image,
  PngError,
  pngSize,
  scaleDown,
  turnQuarter,
} from './png'

describe('pngSize', () => {
  it('reads the size from the IHDR chunk', () => {
    expect(pngSize(pngHeader(2400, 1080))).toEqual({
      width: 2400,
      height: 1080,
    })
  })

  it('gives null for bytes that are not a PNG', () => {
    expect(pngSize(Buffer.from('Error: screencap failed\n'))).toBeNull()
    expect(pngSize(Buffer.alloc(0))).toBeNull()
    expect(pngSize(pngHeader(1080, 2400).subarray(0, 20))).toBeNull()
  })

  it('gives null for a PNG with no width or no height', () => {
    expect(pngSize(pngHeader(0, 2400))).toBeNull()
    expect(pngSize(pngHeader(1080, 0))).toBeNull()
  })
})

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function chunk(type: string, body: Buffer | number[]): Buffer {
  const data = Buffer.from(body)
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'latin1')
  const tail = Buffer.alloc(4)
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0)
  return Buffer.concat([head, data, tail])
}

/** The forward filter of one row, as an encoder writes it. */
function filterRow(
  filter: number,
  row: number[],
  above: number[] | undefined,
  bpp: number,
): number[] {
  return row.map((value, x) => {
    const left = x >= bpp ? row[x - bpp]! : 0
    const up = above?.[x] ?? 0
    const upLeft = above && x >= bpp ? above[x - bpp]! : 0
    const estimate = left + up - upLeft
    const [toLeft, toUp, toUpLeft] = [left, up, upLeft].map((near) =>
      Math.abs(estimate - near),
    )
    const paeth =
      toLeft! <= toUp! && toLeft! <= toUpLeft!
        ? left
        : toUp! <= toUpLeft!
          ? up
          : upLeft
    const predicted = [0, left, up, (left + up) >> 1, paeth][filter]!
    return (value - predicted) & 0xff
  })
}

interface Spec {
  width: number
  colourType: number
  /** The samples of each row, with no filter byte. */
  rows: number[][]
  /** The filter of each row; 0 by default. */
  filters?: number[]
  depth?: number
  interlace?: number
  palette?: number[]
  transparency?: number[]
}

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }

/** A PNG made by hand, so each test knows its exact bytes. */
function png(spec: Spec): Buffer {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(spec.width, 0)
  header.writeUInt32BE(spec.rows.length, 4)
  header[8] = spec.depth ?? 8
  header[9] = spec.colourType
  header[12] = spec.interlace ?? 0
  const bpp = CHANNELS[spec.colourType] ?? 1
  const raw = spec.rows.flatMap((row, y) => {
    const filter = spec.filters?.[y] ?? 0
    return [filter, ...filterRow(filter, row, spec.rows[y - 1], bpp)]
  })
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', header),
    ...(spec.palette ? [chunk('PLTE', spec.palette)] : []),
    ...(spec.transparency ? [chunk('tRNS', spec.transparency)] : []),
    chunk('IDAT', deflateSync(Buffer.from(raw))),
    chunk('IEND', []),
  ])
}

/** The error that `run` throws. */
function thrown(run: () => unknown): unknown {
  try {
    run()
  } catch (error) {
    return error
  }
  throw new Error('It threw nothing.')
}

/** The RGBA bytes of an image, as plain numbers. */
function rgba(image: Image): number[] {
  return [...image.data]
}

describe('decodePng', () => {
  // The pixels come from macOS `sips`, which converted the same files to
  // BMP; on 2026-11-17 all 2.6 million pixels of each file matched it.
  it.each([
    [30, [98, 147], [26, 115, 232]],
    [30, [98, 413], [34, 34, 34]],
    [36, [350, 378], [26, 27, 32]],
    [36, [0, 0], [244, 243, 250]],
  ])(
    'reads a screencap PNG of API %i: the pixel at %j',
    (level, [x = 0, y = 0], rgb) => {
      const file = recorded(`api-${level}/none/rotation-1/settings.png`)
      const image = decodePng(Buffer.from(file.stdout ?? ''))

      expect(image).toMatchObject({ width: 2400, height: 1080 })
      const at = (y * image.width + x) * 4
      expect([...image.data.subarray(at, at + 4)]).toEqual([...rgb, 255])
    },
  )

  it.each([30, 36])(
    'encodes a screencap PNG of API %i back, with no change',
    (level) => {
      const file = recorded(`api-${level}/none/rotation-1/settings.png`)
      const image = decodePng(Buffer.from(file.stdout ?? ''))
      const again = decodePng(encodePng(image))

      // `toEqual` walks a typed array key by key: too slow for 10 MB.
      expect(Buffer.from(again.data).equals(Buffer.from(image.data))).toBe(true)
      expect(
        image.data.every((value, at) => at % 4 !== 3 || value === 255),
      ).toBe(true)
    },
  )

  // Two rows of RGBA, so each filter sees a left, an up and an up-left
  // byte, with sums past 255.
  const rows = [
    [10, 200, 30, 255, 250, 100, 0, 128, 7, 7, 7, 7],
    [255, 0, 128, 64, 1, 254, 99, 200, 128, 128, 255, 0],
  ]

  it.each([0, 1, 2, 3, 4])('undoes filter %i', (filter) => {
    const image = decodePng(
      png({ width: 3, colourType: 6, rows, filters: [filter, filter] }),
    )

    expect(image).toMatchObject({ width: 3, height: 2 })
    expect(rgba(image)).toEqual(rows.flat())
  })

  it.each([
    [
      'gray, with a transparent key',
      {
        width: 3,
        colourType: 0,
        rows: [[0, 128, 255]],
        transparency: [0, 128],
      },
      [0, 0, 0, 255, 128, 128, 128, 0, 255, 255, 255, 255],
    ],
    [
      'gray and alpha',
      { width: 2, colourType: 4, rows: [[10, 20, 30, 40]] },
      [10, 10, 10, 20, 30, 30, 30, 40],
    ],
    [
      'RGB, with a transparent key',
      {
        width: 2,
        colourType: 2,
        rows: [[1, 2, 3, 4, 5, 6]],
        transparency: [0, 4, 0, 5, 0, 6],
      },
      [1, 2, 3, 255, 4, 5, 6, 0],
    ],
    [
      'a palette, with alpha for its first entry',
      {
        width: 3,
        colourType: 3,
        rows: [[1, 0, 1]],
        palette: [9, 8, 7, 1, 2, 3],
        transparency: [50],
      },
      [1, 2, 3, 255, 9, 8, 7, 50, 1, 2, 3, 255],
    ],
  ])('reads %s', (_name, spec, expected) => {
    expect(rgba(decodePng(png(spec)))).toEqual(expected)
  })

  it.each([
    ['16 bits per sample', { depth: 16 }, '16 bits per sample'],
    ['an interlaced PNG', { interlace: 1 }, 'interlaced'],
  ])('gives unsupported for %s', (_name, change, words) => {
    const bytes = png({
      width: 1,
      colourType: 6,
      rows: [[1, 2, 3, 4]],
      ...change,
    })

    expect(thrown(() => decodePng(bytes))).toMatchObject({
      kind: 'unsupported',
      message: expect.stringContaining(words),
    })
  })

  const good = png({ width: 1, colourType: 6, rows: [[1, 2, 3, 4]] })

  it.each([
    [
      'bytes that are no PNG',
      Buffer.from('not a png at all, not at all'),
      "isn't a PNG",
    ],
    [
      'a cut chunk',
      good.subarray(0, good.length - 20),
      'IDAT chunk is cut short',
    ],
    [
      'an unknown filter',
      png({ width: 1, colourType: 6, rows: [[1, 2, 3, 4]], filters: [7] }),
      'unknown filter 7',
    ],
    [
      'a palette entry past the palette',
      png({ width: 1, colourType: 3, rows: [[2]], palette: [1, 2, 3] }),
      "isn't in the palette",
    ],
    [
      'pixel data that is too short',
      png({ width: 2, colourType: 6, rows: [[1, 2, 3, 4]] }),
      'cut short',
    ],
  ])('gives broken for %s', (_name, bytes, words) => {
    const error = thrown(() => decodePng(bytes))

    expect(error).toBeInstanceOf(PngError)
    expect(error).toMatchObject({
      kind: 'broken',
      message: expect.stringContaining(words),
    })
  })
})

describe('encodePng', () => {
  const image: Image = {
    width: 2,
    height: 2,
    data: new Uint8Array([
      1, 2, 3, 4, 250, 251, 252, 253, 0, 0, 0, 0, 9, 8, 7, 6,
    ]),
  }

  it('writes a PNG with the right size and CRCs, that decodes back', () => {
    const bytes = encodePng(image)

    expect(pngSize(bytes)).toEqual({ width: 2, height: 2 })
    for (let offset = 8; offset < bytes.length;) {
      const length = bytes.readUInt32BE(offset)
      const typeAndBody = bytes.subarray(offset + 4, offset + 8 + length)
      expect(bytes.readUInt32BE(offset + 8 + length)).toBe(
        crc32(typeAndBody) >>> 0,
      )
      offset += 12 + length
    }
    expect(rgba(decodePng(bytes))).toEqual(rgba(image))
  })
})

describe('cropImage and scaleDown', () => {
  /** 4 × 4 px in four 2 × 2 blocks: red, green, blue, white. */
  function blocks(): Image {
    const colours = [
      [255, 0, 0, 255],
      [0, 255, 0, 255],
      [0, 0, 255, 255],
      [255, 255, 255, 255],
    ]
    const data: number[] = []
    for (let y = 0; y < 4; y += 1) {
      for (let x = 0; x < 4; x += 1) {
        data.push(...colours[(y >> 1) * 2 + (x >> 1)]!)
      }
    }
    return { width: 4, height: 4, data: new Uint8Array(data) }
  }

  it('crops a rectangle', () => {
    const crop = cropImage(blocks(), { x: 1, y: 1, width: 2, height: 2 })

    expect(crop).toMatchObject({ width: 2, height: 2 })
    expect(rgba(crop)).toEqual([
      255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255,
    ])
  })

  it('takes the mean of each block', () => {
    expect(rgba(scaleDown(blocks(), 0.5))).toEqual([
      255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255,
    ])
    expect(rgba(scaleDown(blocks(), 0.25))).toEqual([128, 128, 128, 255])
  })

  it('keeps the image at a factor of 1, and keeps 1 px at least', () => {
    const image = blocks()

    expect(scaleDown(image, 1)).toBe(image)
    expect(scaleDown(image, 0.01)).toMatchObject({ width: 1, height: 1 })
  })
})

describe('turnQuarter', () => {
  // 3 wide and 2 high: the pixel at (x, y) has the red value 10 * y + x.
  const image: Image = {
    width: 3,
    height: 2,
    data: Uint8Array.from(
      [0, 1, 2, 10, 11, 12].flatMap((red) => [red, 0, 0, 255]),
    ),
  }
  const reds = ({ data }: Image) =>
    Array.from({ length: data.length / 4 }, (_, index) => data[index * 4])

  it('turns to the left: the right edge becomes the top edge', () => {
    const turned = turnQuarter(image, 'left')

    expect([turned.width, turned.height]).toEqual([2, 3])
    expect(reds(turned)).toEqual([2, 12, 1, 11, 0, 10])
  })

  it('turns to the right: the left edge becomes the top edge', () => {
    const turned = turnQuarter(image, 'right')

    expect([turned.width, turned.height]).toEqual([2, 3])
    expect(reds(turned)).toEqual([10, 0, 11, 1, 12, 2])
  })

  it('gives the image back after a turn each way', () => {
    expect(turnQuarter(turnQuarter(image, 'left'), 'right')).toEqual(image)
  })
})
