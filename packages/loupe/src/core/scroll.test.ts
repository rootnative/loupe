import { describe, expect, it } from 'vitest'
import {
  cutAtIncomingEdge,
  scrollStroke,
  scrollViewFor,
  viewContent,
} from './scroll'
import { type UiNode } from './ui'

const SCREEN = { width: 400, height: 800 }

function node(
  [x, y, width, height]: [number, number, number, number],
  extra: Partial<UiNode> = {},
): UiNode {
  return {
    type: 'android.view.ViewGroup',
    frame: { x, y, width, height },
    ...extra,
  }
}

function scroller(
  frame: [number, number, number, number],
  type = 'android.widget.ScrollView',
  children: UiNode[] = [],
  id?: string,
): UiNode {
  return node(frame, { type, scrollable: true, children, id })
}

describe('scrollViewFor', () => {
  it('takes the innermost scroll view: a list in a scrolling page', () => {
    const list = scroller(
      [0, 300, 400, 500],
      'androidx.recyclerview.widget.RecyclerView',
    )
    const page = scroller([0, 0, 400, 800], undefined, [list])

    expect(scrollViewFor([page], 'down', SCREEN)).toBe(list)
  })

  it('takes the scroll view of the axis: a carousel in a page', () => {
    const carousel = scroller(
      [0, 100, 400, 200],
      'android.widget.HorizontalScrollView',
    )
    const page = scroller([0, 0, 400, 800], undefined, [carousel])

    expect(scrollViewFor([page], 'down', SCREEN)).toBe(page)
    expect(scrollViewFor([page], 'right', SCREEN)).toBe(carousel)
  })

  it('takes any scroll view when none scrolls along the axis', () => {
    const list = scroller([0, 0, 400, 800])

    expect(scrollViewFor([list], 'left', SCREEN)).toBe(list)
  })

  it('takes the largest of two, and leaves out one off the screen or with no size', () => {
    const small = scroller([0, 0, 400, 100])
    const large = scroller([0, 100, 400, 700])
    const away = scroller([400, 0, 900, 800])
    const flat = scroller([0, 0, 0, 0])

    expect(scrollViewFor([small, large, away, flat], 'down', SCREEN)).toBe(
      large,
    )
    expect(
      scrollViewFor([away, flat, node([0, 0, 400, 800])], 'down', SCREEN),
    ).toBeNull()
  })

  it('takes the scroll view with the id, which must scroll', () => {
    const named = scroller(
      [0, 0, 400, 100],
      undefined,
      [],
      'com.example:id/list',
    )
    const inner = scroller([0, 100, 400, 700])
    const plain = node([0, 0, 400, 50], { id: 'header' })

    expect(scrollViewFor([named, inner, plain], 'down', SCREEN, 'list')).toBe(
      named,
    )
    expect(() =>
      scrollViewFor([named, plain], 'down', SCREEN, 'header'),
    ).toThrow(
      expect.objectContaining({
        code: 'element_not_found',
        message: 'The element with the id "header" doesn\'t scroll.',
      }),
    )
    expect(() => scrollViewFor([named], 'down', SCREEN, 'nope')).toThrow(
      expect.objectContaining({ code: 'element_not_found' }),
    )
  })
})

describe('scrollStroke', () => {
  const frame = { x: 0, y: 100, width: 400, height: 500 }
  const stroke = (...args: Parameters<typeof scrollStroke>) => {
    const { from, to } = scrollStroke(...args)
    const round = ({ x, y }: { x: number; y: number }) => ({
      x: Math.round(x * 1000) / 1000,
      y: Math.round(y * 1000) / 1000,
    })
    return { from: round(from), to: round(to) }
  }

  it('moves the touch against the direction, over 60 % of the view', () => {
    expect(stroke(frame, 'down')).toEqual({
      from: { x: 200, y: 500 },
      to: { x: 200, y: 200 },
    })
    expect(stroke(frame, 'up')).toEqual({
      from: { x: 200, y: 200 },
      to: { x: 200, y: 500 },
    })
    expect(stroke(frame, 'right')).toEqual({
      from: { x: 320, y: 350 },
      to: { x: 80, y: 350 },
    })
    expect(stroke(frame, 'left')).toEqual({
      from: { x: 80, y: 350 },
      to: { x: 320, y: 350 },
    })
  })

  it('takes a shorter share for the last step', () => {
    expect(stroke(frame, 'down', 0.3)).toEqual({
      from: { x: 200, y: 425 },
      to: { x: 200, y: 275 },
    })
  })
})

describe('viewContent', () => {
  const view = { x: 0, y: 100, width: 400, height: 500 }

  it('changes when a node in the view moves, and not for one outside it', () => {
    const before = [
      node([0, 0, 400, 50], { text: 'Header' }),
      node([0, 150, 400, 50], { text: 'First' }),
    ]
    const header = [
      node([0, 0, 400, 60], { text: 'Header' }),
      node([0, 150, 400, 50], { text: 'First' }),
    ]
    const moved = [
      node([0, 0, 400, 50], { text: 'Header' }),
      node([0, 120, 400, 50], { text: 'First' }),
    ]

    expect(viewContent(header, view)).toBe(viewContent(before, view))
    expect(viewContent(moved, view)).not.toBe(viewContent(before, view))
  })
})

describe('cutAtIncomingEdge', () => {
  const view = { x: 0, y: 100, width: 400, height: 500 }

  it('is true for an element at the edge where content comes in', () => {
    const bottom = { x: 0, y: 560, width: 100, height: 40 }
    const top = { x: 0, y: 100, width: 100, height: 40 }
    const right = { x: 300, y: 300, width: 100, height: 40 }

    expect(cutAtIncomingEdge(bottom, view, 'down', 0.2)).toBe(true)
    expect(cutAtIncomingEdge(bottom, view, 'up', 0.2)).toBe(false)
    expect(cutAtIncomingEdge(top, view, 'up', 0.2)).toBe(true)
    expect(cutAtIncomingEdge(right, view, 'right', 0.2)).toBe(true)
    expect(cutAtIncomingEdge(right, view, 'left', 0.2)).toBe(false)
  })
})
