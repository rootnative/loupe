import { describe, expect, it } from 'vitest'
import {
  checkInset,
  checkOverflow,
  type CheckedScreen,
  checkTouchTarget,
  describeResults,
  rulesOf,
} from './check'
import { type UiNode } from './ui'

const SIZE = { width: 900, height: 400 }

/** A screen in landscape: bars of 24 dp, and a cutout 50 dp wide on the left. */
function screen(nodes: UiNode[], app = 'com.example.app'): CheckedScreen {
  const safeArea = { top: 24, right: 0, bottom: 24, left: 50 }
  return {
    display: {
      orientation: 'landscape-left',
      size: SIZE,
      pixels: { width: 1800, height: 800 },
      scale: 2,
    },
    app,
    nodes,
    insets: {
      orientation: 'landscape-left',
      size: SIZE,
      pixels: { width: 1800, height: 800 },
      scale: 2,
      source: 'probe',
      safeArea,
      systemBars: { top: 24, right: 0, bottom: 24, left: 0 },
      cutout: { top: 0, right: 0, bottom: 0, left: 50 },
      cutoutRects: [{ x: 0, y: 300, width: 50, height: 60 }],
      warnings: [],
    },
  }
}

function node(
  frame: [number, number, number, number],
  extra: Partial<UiNode> = {},
): UiNode {
  const [x, y, width, height] = frame
  return {
    type: 'android.widget.TextView',
    frame: { x, y, width, height },
    ...extra,
  }
}

/** A full-screen root, as uiautomator gives one. */
function root(children: UiNode[], type = 'android.widget.FrameLayout'): UiNode {
  return node([0, 0, SIZE.width, SIZE.height], { type, children })
}

describe('rulesOf', () => {
  it('gives each rule by default, and a comma list in order, once each', () => {
    expect(rulesOf(undefined)).toEqual(['inset', 'overflow', 'touch-target'])
    expect(rulesOf('touch-target, inset,inset')).toEqual([
      'touch-target',
      'inset',
    ])
  })

  it('refuses a name that is not a rule', () => {
    expect(() => rulesOf('inset,centred')).toThrow(
      expect.objectContaining({
        code: 'invalid_input',
        message: expect.stringContaining('"centred" isn\'t a rule'),
      }),
    )
  })
})

describe('checkInset', () => {
  it('finds a label that reaches into an inset, with the numbers', () => {
    const result = checkInset(
      screen([root([node([10, 10, 100, 20], { text: 'Title' })])]),
    )

    expect(result).toMatchObject({ rule: 'inset', passed: false, checked: 1 })
    expect(result.findings).toEqual([
      {
        element: expect.objectContaining({ text: 'Title' }),
        message:
          '"Title" reaches 14 dp into the top inset and 40 dp into the left inset.',
        details: { top: 14, left: 40 },
      },
    ])
  })

  it('says when the element is over the cutout', () => {
    const [finding] = checkInset(
      screen([root([node([10, 320, 100, 20], { label: 'Menu' })])]),
    ).findings

    expect(finding?.message).toMatch(/, over the cutout\.$/)
    expect(finding?.details.cutout).toBe(1)
  })

  it('looks only at elements with text, a label or a touch, on the screen', () => {
    const result = checkInset(
      screen([
        root([
          node([0, 0, 900, 400], { type: 'android.view.ViewGroup' }),
          node([0, 0, 0, 0], { text: 'API 30 gives no size past its cut' }),
          node([10, 10, 30, -20], { text: 'Upside down' }),
          node([60, 30, 100, 20], { text: 'Inside' }),
        ]),
      ]),
    )

    expect(result).toMatchObject({ passed: true, checked: 1 })
  })

  it('skips the edges along the axis of a scroll view, and checks the other axis', () => {
    const list = node([0, 0, 900, 400], {
      type: 'android.widget.ScrollView',
      scrollable: true,
      children: [
        node([60, 390, 100, 20], { text: 'Under the gesture bar' }),
        node([10, 100, 100, 20], { text: 'Under the cutout side' }),
      ],
    })
    const carousel = node([60, 100, 840, 100], {
      type: 'android.widget.HorizontalScrollView',
      scrollable: true,
      children: [node([10, 100, 100, 20], { text: 'Card' })],
    })

    const result = checkInset(screen([root([list, carousel])]))

    expect(result.findings.map((finding) => finding.message)).toEqual([
      '"Under the cutout side" reaches 40 dp into the left inset.',
    ])
  })

  it("leaves out Expo Go's own overlay, and only in Expo Go", () => {
    const overlay = node([0, 0, 100, 100], {
      type: 'c23',
      children: [node([10, 10, 30, 30], { label: 'Tools' })],
    })

    expect(
      checkInset(screen([root([overlay])], 'host.exp.exponent')),
    ).toMatchObject({ passed: true, checked: 0 })
    expect(checkInset(screen([root([overlay])]))).toMatchObject({
      passed: false,
      checked: 1,
    })
  })

  it('takes half a pixel as rounding', () => {
    expect(
      checkInset(
        screen([root([node([49.8, 23.8, 100, 20], { text: 'Edge' })])]),
      ).passed,
    ).toBe(true)
  })
})

describe('checkTouchTarget', () => {
  it('finds a touch target under 48 dp', () => {
    const result = checkTouchTarget(
      screen([
        root([node([100, 100, 24, 24], { label: 'Close', clickable: true })]),
      ]),
    )

    expect(result.findings).toEqual([
      {
        element: expect.objectContaining({ label: 'Close' }),
        message:
          'label "Close" is 24 × 24 dp; a touch target needs 48 × 48 dp.',
        details: { width: 24, height: 24, min: 48 },
      },
    ])
  })

  it('passes 48 dp, and an element that takes no touch', () => {
    expect(
      checkTouchTarget(
        screen([
          root([
            node([100, 100, 48, 48], { clickable: true }),
            node([200, 100, 16, 16], { label: 'Decoration' }),
          ]),
        ]),
      ),
    ).toMatchObject({ passed: true, checked: 1 })
  })

  it("doesn't trust an axis where the element touches the screen or the tree edge", () => {
    // The tree ends at 814 dp, as on API 30 in landscape.
    const short = node([0, 0, 814, 400], {
      children: [
        node([790, 100, 24, 48], { label: 'Cut by the tree', clickable: true }),
        node([100, 376, 48, 24], {
          label: 'Cut by the screen',
          clickable: true,
        }),
      ],
    })

    expect(checkTouchTarget(screen([short])).passed).toBe(true)
  })
})

describe('checkOverflow', () => {
  const row = (last: number) =>
    root([
      node([100, 50, 200, 30], { text: 'One' }),
      node([300, 50, 200, 30], { text: 'Two' }),
      node([500, 50, 200, 30], { text: 'Three' }),
      node([700, 50, last, 30], { text: 'Four' }),
    ])

  it('passes a row whose last item ends at the edge with its full size', () => {
    expect(checkOverflow(screen([row(200)]))).toMatchObject({
      passed: true,
      checked: 4,
    })
  })

  it('finds an item cut at a screen edge, next to siblings that agree on a size', () => {
    const cut = root([
      node([180, 50, 200, 30], { text: 'One' }),
      node([380, 50, 200, 30], { text: 'Two' }),
      node([580, 50, 200, 30], { text: 'Three' }),
      node([780, 50, 120, 30], { text: 'Four' }),
    ])

    expect(checkOverflow(screen([cut])).findings).toEqual([
      {
        element: expect.objectContaining({ text: 'Four' }),
        message:
          '"Four" is cut at the right edge of the screen: 120 dp shows, and its siblings are 200 dp.',
        details: { visible: 120, siblings: 200 },
      },
    ])
  })

  it('needs two siblings in its row that agree on a size', () => {
    const labels = root([
      node([60, 30, 57, 20], { text: 'Top start' }),
      node([849, 30, 51, 20], { text: 'Top end' }),
    ])
    const bar = root([
      node([0, 30, 48, 48], {
        type: 'android.view.ViewGroup',
        label: 'Back',
        clickable: true,
      }),
      node([0, 24, 900, 64], { type: 'android.view.ViewGroup' }),
      node([0, 24, 900, 64], { type: 'android.view.ViewGroup' }),
    ])

    expect(checkOverflow(screen([labels])).passed).toBe(true)
    expect(checkOverflow(screen([bar])).passed).toBe(true)
  })

  it('skips the axis of a scroll view', () => {
    const carousel = root([
      node([0, 100, 900, 100], {
        type: 'android.widget.HorizontalScrollView',
        scrollable: true,
        children: [
          node([100, 100, 200, 100], { text: 'Card 1' }),
          node([300, 100, 200, 100], { text: 'Card 2' }),
          node([500, 100, 200, 100], { text: 'Card 3' }),
          node([700, 100, 200, 100], { text: 'Card 4' }),
          node([900, 100, 0, 100], { text: 'Card 5' }),
        ],
      }),
    ])

    expect(checkOverflow(screen([carousel])).passed).toBe(true)
  })
})

describe('describeResults', () => {
  it('gives one line for each rule and each finding', () => {
    const results = [
      checkInset(screen([root([node([10, 10, 100, 20], { text: 'Title' })])])),
      checkTouchTarget(screen([root([])])),
    ]

    expect(describeResults(results)).toEqual([
      'inset: fail (1 elements, 1 findings)',
      '  "Title" reaches 14 dp into the top inset and 40 dp into the left inset.',
      'touch-target: pass (0 elements)',
    ])
  })
})
