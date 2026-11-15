import { describe, expect, it } from 'vitest'
import { pngHeader } from '../testing/png'
import { pngSize } from './png'

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
