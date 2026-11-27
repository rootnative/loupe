import { describe, expect, it } from 'vitest'
import {
  checkCentred,
  checkInset,
  checkMirrored,
  checkOverflow,
  type CheckedScreen,
  checkTouchTarget,
  describeResults,
  isOverlay,
  rulesOf,
  type ScreenTree,
} from './check'
import { type Image } from './png'
import { type UiNode } from './ui'

const SIZE = { width: 900, height: 400 }

/** A screen in landscape: bars of 24 dp, and a cutout 50 dp wide on the left. */
function screen(nodes: UiNode[], app = 'com.example.app'): CheckedScreen {
  const safeArea = { top: 24, right: 0, bottom: 24, left: 50 }
  return {
    platform: 'android',
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
    expect(rulesOf(undefined)).toEqual([
      'inset',
      'overflow',
      'centred',
      'touch-target',
      'mirrored',
    ])
    expect(rulesOf('touch-target, inset,inset')).toEqual([
      'touch-target',
      'inset',
    ])
  })

  it('refuses a name that is not a rule', () => {
    expect(() => rulesOf('inset,centered')).toThrow(
      expect.objectContaining({
        code: 'invalid_input',
        message: expect.stringContaining('"centered" isn\'t a rule'),
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

  it('leaves out an overlay that covers the screen, and checks what it holds', () => {
    const scrim = node([0, 0, 900, 400], {
      type: 'android.widget.Button',
      label: 'Close sheet',
      clickable: true,
      children: [
        node([60, 100, 200, 20], { text: 'Sheet title' }),
        node([10, 200, 100, 20], { text: 'Under the cutout side' }),
      ],
    })
    const bar = node([0, 0, 900, 64], { label: 'Toolbar' })

    const result = checkInset(screen([root([bar, scrim])]))

    expect(result.checked).toBe(3)
    expect(result.findings.map((finding) => finding.message)).toEqual([
      'label "Toolbar" reaches 24 dp into the top inset and 50 dp into the left inset.',
      '"Under the cutout side" reaches 40 dp into the left inset.',
    ])
  })

  it('leaves out an overlay that covers the tree where it ends short of the screen', () => {
    const scrim = node([0, 0, 860, 400], {
      label: 'Close menu',
      clickable: true,
    })

    expect(
      checkInset(
        screen([
          node([0, 0, 860, 400], {
            type: 'android.widget.FrameLayout',
            children: [scrim],
          }),
        ]),
      ),
    ).toMatchObject({ passed: true, checked: 0 })
  })
})

describe('isOverlay', () => {
  const tree = (overlay: UiNode) => screen([root([overlay])])

  it('is a node with a label or a touch that covers the screen', () => {
    const full = node([0, 0, 900, 400], { label: 'Close menu' })

    expect(isOverlay(full, tree(full))).toBe(true)
  })

  it("isn't a node that leaves an edge free, or one with nothing to read or use", () => {
    const short = node([0, 0, 900, 380], { label: 'Close menu' })
    const plain = node([0, 0, 900, 400], { type: 'android.view.ViewGroup' })

    expect(isOverlay(short, tree(short))).toBe(false)
    expect(isOverlay(plain, tree(plain))).toBe(false)
  })
})

describe('checkTouchTarget', () => {
  it('finds a touch target under 40 dp', () => {
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

  it('gives a warning, no finding, from 40 dp: a hitSlop can make it 48 dp', () => {
    const result = checkTouchTarget(
      screen([
        root([
          node([100, 100, 40, 40], { label: 'More', clickable: true }),
          node([200, 100, 120, 44], { label: 'Chip', clickable: true }),
        ]),
      ]),
    )

    expect(result).toMatchObject({ passed: true, checked: 2, findings: [] })
    expect(result.warnings).toEqual([
      'label "More" is 40 × 40 dp; a hitSlop of 4 dp on each side makes it 48 × 48 dp, but the tree doesn\'t show hitSlop.',
      'label "Chip" is 120 × 44 dp; a hitSlop of 2 dp on each side makes it 124 × 48 dp, but the tree doesn\'t show hitSlop.',
    ])
  })

  it('finds a target under 40 dp on one axis, and takes half a pixel as rounding at 40', () => {
    const result = checkTouchTarget(
      screen([
        root([
          node([100, 100, 48, 39], { label: 'Thin', clickable: true }),
          node([200, 100, 39.8, 48], { label: 'Rounded', clickable: true }),
        ]),
      ]),
    )

    expect(result.findings.map((finding) => finding.element.label)).toEqual([
      'Thin',
    ])
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings?.[0]).toMatch(/^label "Rounded"/)
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

describe('checkCentred', () => {
  const button = (x: number, label: string) =>
    node([x, 32, 48, 48], {
      type: 'android.view.ViewGroup',
      label,
      clickable: true,
    })

  /**
   * A bar across the safe area (50–900 dp, centre 475), a back button and
   * three actions. As in Fabric's tree, they sit beside the bar, not in it.
   */
  function bar(title: UiNode, width = SIZE.width): UiNode {
    return root([
      node([50, 24, width - 50, 64], {
        type: 'android.view.ViewGroup',
        id: 'bar',
      }),
      button(50, 'Back'),
      title,
      button(width - 144, 'Search'),
      button(width - 96, 'Share'),
      button(width - 48, 'More'),
    ])
  }

  const title = (x: number, width = 120) =>
    node([x, 44, width, 24], { text: 'Title', id: 'title' })

  it('finds a title clear of both ends, off the centre of its container', () => {
    const result = checkCentred(screen([bar(title(520))]))

    expect(result).toMatchObject({ rule: 'centred', passed: false, checked: 1 })
    expect(result.findings).toEqual([
      {
        element: expect.objectContaining({ text: 'Title' }),
        message:
          '"Title" sits between label "Back" and label "Search", clear of both, but 105 dp right of the centre of its container, #bar.',
        details: {
          offCentre: 105,
          centre: 580,
          containerCentre: 475,
          leftGap: 422,
          rightGap: 116,
        },
      },
    ])
  })

  it('passes a title within 4 dp of the centre', () => {
    expect(checkCentred(screen([bar(title(415))]))).toMatchObject({
      passed: true,
      checked: 1,
    })
    expect(checkCentred(screen([bar(title(419))])).passed).toBe(true)
    expect(checkCentred(screen([bar(title(420))])).passed).toBe(false)
  })

  it('skips a title within 24 dp of an end: it can be aligned to it', () => {
    expect(checkCentred(screen([bar(title(122))]))).toMatchObject({
      passed: true,
      checked: 0,
    })
  })

  it('skips a text with nothing on one side, a row of like items, and a horizontal scroll view', () => {
    const oneSide = root([button(50, 'Back'), title(520)])
    const likeItems = root(
      ['One', 'Two', 'Three', 'Four'].map((text, index) =>
        node([100 + index * 200, 200, 60, 20], { text }),
      ),
    )
    const carousel = root([
      node([0, 100, 900, 100], {
        type: 'android.widget.HorizontalScrollView',
        scrollable: true,
        children: [button(100, 'Previous'), title(520), button(800, 'Next')],
      }),
    ])

    for (const nodes of [oneSide, likeItems, carousel]) {
      expect(checkCentred(screen([nodes]))).toMatchObject({
        passed: true,
        checked: 0,
      })
    }
  })

  it('skips a container that ends where the tree ends, short of the screen', () => {
    // On API 30 in landscape, the tree and the bar end at 814 dp.
    const short = {
      ...bar(title(470), 814),
      frame: { x: 0, y: 0, width: 814, height: 400 },
    }

    expect(checkCentred(screen([short]))).toMatchObject({
      passed: true,
      checked: 0,
    })
  })

  describe('with a screenshot', () => {
    const SCALE = 2

    /** The screen at 2 px per dp: the bar, its buttons, and black ink. */
    function shot(ink: { from: number; to: number }): Image {
      const width = SIZE.width * SCALE
      const height = SIZE.height * SCALE
      const data = new Uint8Array(width * height * 4)
      const paint = (
        x: number,
        y: number,
        w: number,
        h: number,
        colour: number[],
      ) => {
        for (let row = y * SCALE; row < (y + h) * SCALE; row += 1) {
          for (let column = x * SCALE; column < (x + w) * SCALE; column += 1) {
            data.set([...colour, 255], (row * width + column) * 4)
          }
        }
      }
      paint(0, 0, SIZE.width, SIZE.height, [0xf3, 0xf0, 0xea])
      paint(50, 24, 850, 64, [0xd9, 0xe2, 0xec])
      for (const x of [50, 756, 804, 852])
        paint(x, 32, 48, 48, [0xbc, 0xcc, 0xdc])
      paint(ink.from, 48, ink.to - ink.from, 16, [0, 0, 0])
      return { width, height, data }
    }

    it('finds text centred in a wide frame that fills the space between the ends', () => {
      const wide = title(98, 658)
      const centredInFrame = { from: 397, to: 457 }

      expect(checkCentred(screen([bar(wide)])).checked).toBe(0)
      const result = checkCentred({
        ...screen([bar(wide)]),
        image: shot(centredInFrame),
      })
      expect(result.findings.map((finding) => finding.message)).toEqual([
        '"Title" sits between label "Back" and label "Search", clear of both, but 48 dp left of the centre of its container, #bar.',
      ])
    })

    it('passes text at the centre of a frame over the whole bar, with the buttons masked', () => {
      const over = node([50, 24, 850, 64], { text: 'Title' })

      expect(
        checkCentred({
          ...screen([bar(over)]),
          image: shot({ from: 445, to: 505 }),
        }),
      ).toMatchObject({ passed: true, checked: 1 })
    })
  })

  describe('a named element', () => {
    it('is checked against its container, whatever sits beside it', () => {
      const result = checkCentred(screen([bar(title(122))]), {
        centred: [
          { by: 'text', value: 'Title' },
          { by: 'id', value: 'title' },
        ],
      })

      expect(result).toMatchObject({ passed: false, checked: 1 })
      expect(result.findings).toEqual([
        {
          element: expect.objectContaining({ text: 'Title' }),
          message:
            '"Title" is 293 dp left of the centre of its container, #bar.',
          details: { offCentre: -293, centre: 182, containerCentre: 475 },
        },
      ])
    })

    it('must be on the screen', () => {
      expect(() =>
        checkCentred(screen([bar(title(415))]), {
          centred: [{ by: 'text', value: 'Heading' }],
        }),
      ).toThrow(expect.objectContaining({ code: 'element_not_found' }))
    })

    it('gives a warning when the tree cuts its container short', () => {
      const short = {
        ...bar(title(470), 814),
        frame: { x: 0, y: 0, width: 814, height: 400 },
      }

      expect(
        checkCentred(screen([short]), {
          centred: [{ by: 'text', value: 'Title' }],
        }),
      ).toEqual({
        rule: 'centred',
        passed: true,
        checked: 0,
        findings: [],
        warnings: [
          'loupe can\'t find the centre of the container of "Title": the tree ends short of the screen there.',
        ],
      })
    })
  })
})

describe('checkMirrored', () => {
  // The safe area is 50–900 dp: its centre is 475 dp.
  const edit = (x: number, extra: Partial<UiNode> = {}) =>
    node([x, 100, 140, 20], { text: 'Edit', ...extra })

  function rtl(nodes: UiNode[]): CheckedScreen {
    return { ...screen([root(nodes)]), direction: 'rtl' }
  }

  function ltr(nodes: UiNode[]): ScreenTree {
    const { platform, display, app } = screen([])
    return { platform, display, app, nodes: [root(nodes)], direction: 'ltr' }
  }

  it('passes an element mirrored about the centre of the safe area', () => {
    expect(
      checkMirrored(rtl([edit(750)]), { mirrorOf: ltr([edit(60)]) }),
    ).toEqual({ rule: 'mirrored', passed: true, checked: 1, findings: [] })
  })

  it('finds an element that RTL leaves on the side where LTR puts it', () => {
    const { findings } = checkMirrored(rtl([edit(10)]), {
      mirrorOf: ltr([edit(60)]),
    })

    expect(findings).toEqual([
      {
        element: expect.objectContaining({ text: 'Edit' }),
        message:
          '"Edit" sits at 10–150 dp in RTL. LTR puts it at 60–200 dp, so mirrored it belongs at 750–890 dp.',
        details: {
          from: 10,
          to: 150,
          expectedFrom: 750,
          expectedTo: 890,
          referenceFrom: 60,
          referenceTo: 200,
        },
      },
    ])
  })

  it('takes LTR as the reference when this screen is the LTR one', () => {
    const live: CheckedScreen = {
      ...screen([root([edit(60)])]),
      direction: 'ltr',
    }
    const saved = { ...ltr([edit(10)]), direction: 'rtl' as const }

    expect(
      checkMirrored(live, { mirrorOf: saved }).findings.map(
        (finding) => finding.message,
      ),
    ).toEqual([
      '"Edit" sits at 10–150 dp in RTL. LTR puts it at 60–200 dp, so mirrored it belongs at 750–890 dp.',
    ])
  })

  it('takes the saved screen as the reference with no directions', () => {
    const live = screen([root([edit(10)])])
    const saved = { ...screen([]), nodes: [root([edit(60)])] }

    expect(checkMirrored(live, { mirrorOf: saved }).findings[0]?.message).toBe(
      '"Edit" sits at 10–150 dp in this screen. The saved screen puts it at 60–200 dp, so mirrored it belongs at 750–890 dp.',
    )
  })

  it('lets an element that LTR centres on the screen stay where it is', () => {
    const caption = node([400, 300, 100, 20], { text: 'Caption' })

    expect(
      checkMirrored(rtl([caption]), { mirrorOf: ltr([caption]) }),
    ).toMatchObject({ passed: true, checked: 1 })
  })

  it('lets an element in a side inset mirror about the centre of the screen', () => {
    // LTR puts it under the cutout, and RTL in the far corner: `inset`
    // reports the LTR one.
    const corner = (x: number) => node([x, 30, 60, 20], { text: 'Corner' })

    expect(
      checkMirrored(rtl([corner(840)]), { mirrorOf: ltr([corner(0)]) }),
    ).toMatchObject({ passed: true, checked: 1 })
  })

  it('pairs by id, then label, then text, each once on each screen', () => {
    const live = rtl([
      node([10, 100, 140, 20], { id: 'first', text: 'Item' }),
      node([10, 140, 140, 20], { text: 'Item' }),
      node([10, 180, 140, 20], { label: 'Only here' }),
    ])
    const saved = ltr([
      node([60, 100, 140, 20], { id: 'first', text: 'Item' }),
      node([60, 140, 140, 20], { text: 'Item' }),
    ])

    const result = checkMirrored(live, { mirrorOf: saved })

    expect(result.checked).toBe(1)
    expect(result.findings.map((finding) => finding.element.id)).toEqual([
      'first',
    ])
  })

  it("doesn't compare an edge at the screen or at the end of the tree", () => {
    const wide = (from: number, to: number) =>
      node([from, 100, to - from, 20], { text: 'Wide' })
    const mirrored = (here: UiNode, there: UiNode) =>
      checkMirrored(rtl([here]), { mirrorOf: ltr([there]) })

    expect(mirrored(wide(0, 900), wide(0, 900))).toMatchObject({
      passed: true,
      checked: 0,
    })
    // Only LTR's left edge is known, so only RTL's right edge counts.
    expect(mirrored(wide(0, 850), wide(100, 900))).toMatchObject({
      passed: true,
      checked: 1,
    })
    expect(mirrored(wide(0, 700), wide(100, 900)).passed).toBe(false)
  })

  it('needs the other screen', () => {
    expect(() => checkMirrored(rtl([edit(750)]))).toThrow(
      expect.objectContaining({ code: 'invalid_input' }),
    )
  })
})

describe('describeResults', () => {
  it('gives one line for each rule, each finding and each warning', () => {
    const results = [
      checkInset(screen([root([node([10, 10, 100, 20], { text: 'Title' })])])),
      checkTouchTarget(screen([root([])])),
      { ...checkTouchTarget(screen([root([])])), warnings: ['Look again.'] },
    ]

    expect(describeResults(results)).toEqual([
      'inset: fail (1 elements, 1 findings)',
      '  "Title" reaches 14 dp into the top inset and 40 dp into the left inset.',
      'touch-target: pass (0 elements)',
      'touch-target: pass (0 elements)',
      '  Warning: Look again.',
    ])
  })
})
