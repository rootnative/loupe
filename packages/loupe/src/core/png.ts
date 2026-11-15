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
