import { crc32, deflateSync, inflateSync } from 'node:zlib'
import { type Size } from './units'

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/**
 * The size in px from the IHDR chunk, which a PNG must put first. Null when
 * the bytes aren't a PNG.
 */
export function pngSize(bytes: Buffer): Size | null {
  if (
    bytes.length < 24 ||
    !bytes.subarray(0, 8).equals(SIGNATURE) ||
    bytes.toString('latin1', 12, 16) !== 'IHDR'
  ) {
    return null
  }
  const width = bytes.readUInt32BE(16)
  const height = bytes.readUInt32BE(20)
  return width > 0 && height > 0 ? { width, height } : null
}

/** An image in memory: 8-bit RGBA, row by row from the top. */
export interface Image {
  width: number
  height: number
  /** 4 bytes for each pixel: red, green, blue, alpha. */
  data: Uint8Array
}

/**
 * A PNG that loupe can't decode. `unsupported`: a valid PNG of a kind that
 * loupe doesn't read. `broken`: not a valid PNG.
 */
export class PngError extends Error {
  constructor(
    readonly kind: 'unsupported' | 'broken',
    message: string,
  ) {
    super(message)
    this.name = 'PngError'
  }
}

/** The channels of each colour type: gray, RGB, palette, gray + alpha, RGBA. */
const CHANNELS = new Map([
  [0, 1],
  [2, 3],
  [3, 1],
  [4, 2],
  [6, 4],
])

interface Header {
  width: number
  height: number
  colourType: number
  channels: number
}

function readHeader(body: Buffer): Header {
  if (body.length !== 13) throw new PngError('broken', 'Its IHDR is broken.')
  const width = body.readUInt32BE(0)
  const height = body.readUInt32BE(4)
  const [depth, colourType = -1, compression, filter, interlace] =
    body.subarray(8)
  const channels = CHANNELS.get(colourType)
  if (width === 0 || height === 0 || !channels || compression || filter) {
    throw new PngError('broken', 'Its IHDR is broken.')
  }
  if (depth !== 8) {
    throw new PngError(
      'unsupported',
      `It has ${depth} bits per sample, and loupe reads only 8.`,
    )
  }
  if (interlace) {
    throw new PngError(
      'unsupported',
      "It's interlaced, and loupe reads only PNGs with no interlace.",
    )
  }
  return { width, height, colourType, channels }
}

function paeth(left: number, up: number, upLeft: number): number {
  const estimate = left + up - upLeft
  const toLeft = Math.abs(estimate - left)
  const toUp = Math.abs(estimate - up)
  const toUpLeft = Math.abs(estimate - upLeft)
  if (toLeft <= toUp && toLeft <= toUpLeft) return left
  return toUp <= toUpLeft ? up : upLeft
}

/**
 * Undoes the filter of each row: gives the samples with no filter bytes.
 * Bytes left of the first pixel and above the first row count as 0. A
 * `Uint8Array` keeps each sum modulo 256, as the filters need.
 */
function unfilter(raw: Buffer, height: number, stride: number, bpp: number) {
  const out = new Uint8Array(height * stride)
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)]
    const from = y * (stride + 1) + 1
    const row = y * stride
    const above = row - stride
    const at = (x: number) => raw[from + x]!
    const left = (x: number) => (x >= bpp ? out[row + x - bpp]! : 0)
    const up = (x: number) => (y > 0 ? out[above + x]! : 0)
    const upLeft = (x: number) =>
      y > 0 && x >= bpp ? out[above + x - bpp]! : 0

    switch (filter) {
      case 0:
        out.set(raw.subarray(from, from + stride), row)
        break
      case 1:
        for (let x = 0; x < stride; x += 1) out[row + x] = at(x) + left(x)
        break
      case 2:
        for (let x = 0; x < stride; x += 1) out[row + x] = at(x) + up(x)
        break
      case 3:
        for (let x = 0; x < stride; x += 1) {
          out[row + x] = at(x) + ((left(x) + up(x)) >> 1)
        }
        break
      case 4:
        for (let x = 0; x < stride; x += 1) {
          out[row + x] = at(x) + paeth(left(x), up(x), upLeft(x))
        }
        break
      default:
        throw new PngError(
          'broken',
          `Row ${y} has the unknown filter ${filter}.`,
        )
    }
  }
  return out
}

function toRgba(
  samples: Uint8Array,
  { width, height, colourType }: Header,
  palette: Buffer | undefined,
  transparency: Buffer | undefined,
): Uint8Array {
  if (colourType === 6) return samples

  const rgba = new Uint8Array(width * height * 4)
  const put = (pixel: number, r: number, g: number, b: number, a: number) => {
    rgba[pixel * 4] = r
    rgba[pixel * 4 + 1] = g
    rgba[pixel * 4 + 2] = b
    rgba[pixel * 4 + 3] = a
  }
  // A tRNS key is 16 bits for each sample; at 8 bits only the low byte
  // counts.
  const key = (sample: number, value: number) =>
    transparency?.[sample * 2 + 1] === value

  for (let pixel = 0; pixel < width * height; pixel += 1) {
    if (colourType === 0) {
      const gray = samples[pixel]!
      const opaque = transparency?.length === 2 && key(0, gray) ? 0 : 255
      put(pixel, gray, gray, gray, opaque)
    } else if (colourType === 4) {
      const gray = samples[pixel * 2]!
      put(pixel, gray, gray, gray, samples[pixel * 2 + 1]!)
    } else if (colourType === 2) {
      const r = samples[pixel * 3]!
      const g = samples[pixel * 3 + 1]!
      const b = samples[pixel * 3 + 2]!
      const keyed =
        transparency?.length === 6 && key(0, r) && key(1, g) && key(2, b)
      put(pixel, r, g, b, keyed ? 0 : 255)
    } else {
      const index = samples[pixel]!
      if (!palette || index * 3 + 2 >= palette.length) {
        throw new PngError(
          'broken',
          `A pixel uses palette entry ${index}, which isn't in the palette.`,
        )
      }
      put(
        pixel,
        palette[index * 3]!,
        palette[index * 3 + 1]!,
        palette[index * 3 + 2]!,
        transparency?.[index] ?? 255,
      )
    }
  }
  return rgba
}

/**
 * Decodes a PNG to 8-bit RGBA. It reads 8-bit gray, gray + alpha, RGB, RGBA
 * and palette PNGs with no interlace, as `screencap` writes them. It doesn't
 * check the CRCs: zlib checks the pixel data. Throws `PngError`.
 */
export function decodePng(bytes: Buffer): Image {
  if (!pngSize(bytes)) throw new PngError('broken', "It isn't a PNG.")

  let header: Header | undefined
  let palette: Buffer | undefined
  let transparency: Buffer | undefined
  const data: Buffer[] = []
  let ended = false
  for (let offset = 8; offset + 8 <= bytes.length && !ended;) {
    const length = bytes.readUInt32BE(offset)
    const type = bytes.toString('latin1', offset + 4, offset + 8)
    const start = offset + 8
    const end = start + length
    if (end > bytes.length) {
      throw new PngError('broken', `Its ${type} chunk is cut short.`)
    }
    const body = bytes.subarray(start, end)
    if (type === 'IHDR') header = readHeader(body)
    else if (type === 'PLTE') palette = body
    else if (type === 'tRNS') transparency = body
    else if (type === 'IDAT') data.push(body)
    else if (type === 'IEND') ended = true
    offset = end + 4
  }
  if (!header) throw new PngError('broken', 'It has no IHDR.')

  let raw: Buffer
  try {
    raw = inflateSync(Buffer.concat(data))
  } catch {
    throw new PngError('broken', 'Its pixel data is broken.')
  }
  const stride = header.width * header.channels
  if (raw.length < header.height * (stride + 1)) {
    throw new PngError('broken', 'Its pixel data is cut short.')
  }
  const samples = unfilter(raw, header.height, stride, header.channels)
  return {
    width: header.width,
    height: header.height,
    data: toRgba(samples, header, palette, transparency),
  }
}

function chunk(type: string, body: Buffer): Buffer {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(body.length, 0)
  head.write(type, 4, 'latin1')
  const tail = Buffer.alloc(4)
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])) >>> 0, 0)
  return Buffer.concat([head, body, tail])
}

/**
 * Encodes an image as an 8-bit RGBA PNG. Each row uses the "up" filter:
 * a screen has many rows that repeat the row above.
 */
export function encodePng({ width, height, data }: Image): Buffer {
  const stride = width * 4
  const raw = Buffer.alloc(height * (stride + 1))
  for (let y = 0; y < height; y += 1) {
    const at = y * (stride + 1)
    raw[at] = 2
    const row = y * stride
    for (let x = 0; x < stride; x += 1) {
      const above = y > 0 ? data[row - stride + x]! : 0
      raw[at + 1 + x] = (data[row + x]! - above) & 0xff
    }
  }

  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 6
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** A rectangle in px, inside the image. */
export interface PixelRect {
  x: number
  y: number
  width: number
  height: number
}

/** The part of the image in `rect`, which must be inside it. */
export function cropImage(image: Image, rect: PixelRect): Image {
  const data = new Uint8Array(rect.width * rect.height * 4)
  for (let y = 0; y < rect.height; y += 1) {
    const from = ((rect.y + y) * image.width + rect.x) * 4
    data.set(
      image.data.subarray(from, from + rect.width * 4),
      y * rect.width * 4,
    )
  }
  return { width: rect.width, height: rect.height, data }
}

/**
 * The image scaled down by `factor` (more than 0, at most 1). Each new
 * pixel is the mean of the pixels it covers.
 */
export function scaleDown(image: Image, factor: number): Image {
  const width = Math.max(1, Math.round(image.width * factor))
  const height = Math.max(1, Math.round(image.height * factor))
  if (width === image.width && height === image.height) return image

  const data = new Uint8Array(width * height * 4)
  // The source span of each new row and column: [start, end).
  const span = (index: number, from: number, to: number) => {
    const start = Math.floor((index * from) / to)
    return [start, Math.max(start + 1, Math.floor(((index + 1) * from) / to))]
  }
  for (let y = 0; y < height; y += 1) {
    const [top = 0, bottom = 0] = span(y, image.height, height)
    for (let x = 0; x < width; x += 1) {
      const [left = 0, right = 0] = span(x, image.width, width)
      const count = (bottom - top) * (right - left)
      for (let channel = 0; channel < 4; channel += 1) {
        let sum = 0
        for (let sy = top; sy < bottom; sy += 1) {
          for (let sx = left; sx < right; sx += 1) {
            sum += image.data[(sy * image.width + sx) * 4 + channel]!
          }
        }
        data[(y * width + x) * 4 + channel] = Math.round(sum / count)
      }
    }
  }
  return { width, height, data }
}
