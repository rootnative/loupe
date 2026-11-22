import { describe, expect, it } from 'vitest'
import { LoupeError } from './errors'
import { type Image } from './png'
import {
  describeWaited,
  noElement,
  notStill,
  sameRegion,
  waitForElement,
  waitForStill,
  withWaited,
} from './wait'

/** A gray image, 4 × 4 px, with one changed pixel when `at` is given. */
function gray(at?: [number, number]): Image {
  const data = new Uint8Array(4 * 4 * 4).fill(100)
  if (at) data[(at[1] * 4 + at[0]) * 4] = 200
  return { width: 4, height: 4, data }
}

const INNER = { x: 1, y: 1, width: 2, height: 2 }
const NOW = { timeout: 10_000, interval: 0 }

describe('sameRegion', () => {
  it.each([
    ['the same image', gray(), true],
    ['a change outside the region', gray([0, 0]), true],
    ['a change inside the region', gray([2, 2]), false],
  ])('gives %s: %s', (_name, other, same) => {
    expect(sameRegion(gray(), other, INNER)).toBe(same)
  })

  it('gives false for another size', () => {
    expect(
      sameRegion(gray(), { width: 2, height: 8, data: gray().data }, INNER),
    ).toBe(false)
  })
})

describe('waitForStill', () => {
  /** PNGs by name; `decode` looks each one up and counts the decodes. */
  function source(names: string[], images: Record<string, Image>) {
    const queue = [...names]
    let decodes = 0
    return {
      decodes: () => decodes,
      take: async () => Buffer.from(queue.shift() ?? names.at(-1) ?? ''),
      decode: (png: Buffer) => {
        decodes += 1
        return images[png.toString()] ?? gray()
      },
      regionOf: async () => INNER,
    }
  }

  it('stops at the first two equal PNGs, with no decode for them', async () => {
    const frames = source(['a', 'b', 'b'], { a: gray([1, 1]), b: gray() })

    expect(await waitForStill(frames, NOW)).toMatchObject({
      still: true,
      frames: 3,
    })
    expect(frames.decodes()).toBe(2)
  })

  it('compares the pixels inside the region only', async () => {
    // The clock in the status bar changes; the rest keeps still.
    const frames = source(['a', 'b'], { a: gray(), b: gray([0, 0]) })

    expect(await waitForStill(frames, NOW)).toMatchObject({
      still: true,
      frames: 2,
    })
  })

  it('takes two screenshots at least, and stops at the timeout', async () => {
    const frames = source(['a', 'b', 'c'], {
      a: gray([1, 1]),
      b: gray([2, 2]),
      c: gray([1, 2]),
    })

    expect(
      await waitForStill(frames, { timeout: 0, interval: 0 }),
    ).toMatchObject({ still: false, frames: 2 })
  })

  it('stops with cancelled before the next screenshot', async () => {
    const controller = new AbortController()
    const frames = source(['a', 'b', 'c'], {
      a: gray([1, 1]),
      b: gray([2, 2]),
      c: gray([1, 2]),
    })
    const take = frames.take
    let taken = 0
    frames.take = async () => {
      taken += 1
      if (taken === 2) controller.abort()
      return take()
    }

    await expect(
      waitForStill(frames, { ...NOW, signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'cancelled' })
    expect(taken).toBe(2)
  })
})

describe('waitForElement', () => {
  const element = {
    type: 'android.widget.TextView',
    text: 'Title',
    frame: { x: 0, y: 0, width: 10, height: 10 },
  }

  it('reads past "not yet" errors until the element comes', async () => {
    const reads = [
      () => {
        throw new LoupeError('not_idle', 'Still moving.')
      },
      () => {
        throw new LoupeError('app_not_in_front', 'Not in front yet.')
      },
      () => undefined,
      () => element,
    ]
    let read = 0

    expect(
      await waitForElement(async () => reads[read++]!(), NOW),
    ).toMatchObject({ element, reads: 4 })
  })

  it('stops at another error', async () => {
    await expect(
      waitForElement(async () => {
        throw new LoupeError('tool_failed', 'adb is gone.')
      }, NOW),
    ).rejects.toMatchObject({ code: 'tool_failed' })
  })

  it('stops with cancelled before the next read', async () => {
    const controller = new AbortController()
    let reads = 0

    await expect(
      waitForElement(
        async () => {
          reads += 1
          controller.abort()
          return undefined
        },
        { ...NOW, signal: controller.signal },
      ),
    ).rejects.toMatchObject({ code: 'cancelled' })
    expect(reads).toBe(1)
  })

  it('gives no element at the timeout, with the last error it went past', async () => {
    const result = await waitForElement(
      async () => {
        throw new LoupeError('not_idle', 'Still moving.')
      },
      { timeout: 0, interval: 0 },
    )

    expect(result).toMatchObject({ reads: 1 })
    expect(result.element).toBeUndefined()
    expect(noElement('text "Title"', result)).toMatch(
      /^no element with the text "Title" came on the screen in \d+ ms \(1 reads\)\. The last read said: Still moving\.$/,
    )
  })
})

describe('the words', () => {
  it('says why the screen is not still', () => {
    expect(notStill({ still: false, frames: 7, ms: 10_012 })).toBe(
      "the screen didn't keep still in 10012 ms (7 screenshots). An animation that never stops can cause this; take a screenshot instead.",
    )
  })

  it('describes the wait after an action', () => {
    const element = {
      type: 'android.widget.TextView',
      text: 'Title',
      frame: { x: 0, y: 0, width: 10, height: 10 },
    }

    expect(describeWaited({ ms: 1234, frames: 3 })).toBe(
      'waited 1.23 s until still (3 screenshots)',
    )
    expect(describeWaited({ ms: 3300, reads: 2, element, frames: 2 })).toBe(
      'waited 3.3 s for "Title" (2 reads), then until still (2 screenshots)',
    )
    expect(withWaited('Tapped', { ms: 500, frames: 2 })).toBe(
      'Tapped\nThen waited 0.5 s until still (2 screenshots).',
    )
    expect(withWaited('Tapped', undefined)).toBe('Tapped')
  })
})
