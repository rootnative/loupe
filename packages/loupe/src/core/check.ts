import { z } from 'zod'
import { type DisplayState, displaySchema } from './display'
import {
  describeElement,
  type Element,
  elementSchema,
  findNode,
  type Selector,
} from './element'
import { LoupeError } from './errors'
import { type ColumnSpan, inkColumns } from './ink'
import { EDGES, type Edge, type InsetsReading } from './insets'
import { type Image, type PixelRect } from './png'
import { type Axis, scrollAxisOf, type UiNode } from './ui'
import {
  containsRect,
  intersection,
  type Rect,
  rectRight,
  round2,
} from './units'

export const RULES = [
  'inset',
  'overflow',
  'centred',
  'touch-target',
  'mirrored',
] as const

export type RuleName = (typeof RULES)[number]

/** The smallest touch target on Android, in dp (48 × 48). */
export const MIN_TOUCH_TARGET = 48

/** `centred` finds an element more than this off centre, in dp. */
export const CENTRE_TOLERANCE = 4

/**
 * A text more than this from the elements on each side, in dp, is aligned
 * to neither of them, so `centred` expects it at the centre of its
 * container.
 */
export const CLEAR_GAP = 24

export const findingSchema = z.object({
  element: elementSchema,
  message: z
    .string()
    .describe('What is wrong, with the numbers, for a person.'),
  details: z
    .record(z.string(), z.number())
    .describe('The numbers of the finding, in dp, by name.'),
})

export type Finding = z.infer<typeof findingSchema>

export const ruleResultSchema = z.object({
  rule: z.enum(RULES),
  passed: z.boolean(),
  checked: z.number().describe('The elements that the rule looked at.'),
  findings: z.array(findingSchema),
  warnings: z
    .array(z.string())
    .optional()
    .describe('Elements that you named, but the rule could not check.'),
})

export type RuleResult = z.infer<typeof ruleResultSchema>

/** One checked screen: the output of `check`, and of each screen of `sweep`. */
export const screenCheckSchema = displaySchema.extend({
  app: z.string().optional().describe('The package of the window in the tree.'),
  safeAreaSource: z
    .enum(['probe', 'dumpsys'])
    .describe('Where the safe area comes from, as in `insets`.'),
  passed: z.boolean().describe('True when every rule passed.'),
  results: z.array(ruleResultSchema),
  warnings: z.array(z.string()),
})

export type ScreenCheck = z.infer<typeof screenCheckSchema>

/** The tree of one screen, as `ui` gives it. Sizes in dp. */
export interface ScreenTree {
  display: DisplayState
  /** The package of the window in the tree. */
  app?: string
  nodes: readonly UiNode[]
  /** The layout direction, from the probe. */
  direction?: 'ltr' | 'rtl'
}

/** One screen, as the rules see it. */
export interface CheckedScreen extends ScreenTree {
  insets: InsetsReading
  /**
   * A screenshot of the same screen, in px. `centred` finds the ink of a
   * text in it; with no image, it takes the whole frame as the ink.
   */
  image?: Image
}

export interface CheckOptions {
  /** Elements that must be at the centre of their container (`centred`). */
  centred?: readonly Selector[]
  /** The same screen in the other layout direction (`mirrored`). */
  mirrorOf?: ScreenTree
}

/** One node, with what the rules need to know about where it sits. */
interface Placed {
  node: UiNode
  siblings: readonly UiNode[]
  /** The axes of the scroll views around it. */
  scrollAxes: ReadonlySet<Axis>
}

const EXPO_GO = 'host.exp.exponent'

/**
 * Each node that the rules can look at. In Expo Go, its own overlay (the
 * "Tools" button) sits in a subtree under a class that isn't `android.*`;
 * the app's views are all `android.*`, so that subtree is left out.
 */
function place(screen: ScreenTree): Placed[] {
  const skipOwn = screen.app === EXPO_GO
  const placed: Placed[] = []
  const walk = (
    nodes: readonly UiNode[],
    scrollAxes: ReadonlySet<Axis>,
  ): void => {
    for (const node of nodes) {
      if (skipOwn && !node.type.startsWith('android.')) continue
      placed.push({ node, siblings: nodes, scrollAxes })
      const inner = node.scrollable
        ? new Set([...scrollAxes, scrollAxisOf(node)])
        : scrollAxes
      walk(node.children ?? [], inner)
    }
  }
  walk(screen.nodes, new Set())
  return placed
}

function toElement({ type, text, label, id, frame }: UiNode): Element {
  return { type, text, label, id, frame }
}

/** True when the node has some area on the screen. */
function onScreen(node: UiNode, screen: ScreenTree): boolean {
  const { width, height } = node.frame
  return (
    width > 0 &&
    height > 0 &&
    intersection(node.frame, { x: 0, y: 0, ...screen.display.size }) !== null
  )
}

/** Text, a label or a touch: a person can read it or use it. */
function matters(node: UiNode): boolean {
  return Boolean(
    node.text || node.label || node.clickable || node.longClickable,
  )
}

/** Half a pixel, in dp: less is rounding. */
function tolerance(screen: ScreenTree): number {
  return 0.5 / screen.display.scale
}

const AXIS_OF: Record<Edge, Axis> = {
  top: 'y',
  bottom: 'y',
  left: 'x',
  right: 'x',
}

/** How far the frame reaches past each edge of `inner`, in dp; 0 or more. */
function reachPast(frame: Rect, inner: Rect): Record<Edge, number> {
  return {
    top: Math.max(0, inner.y - frame.y),
    right: Math.max(0, frame.x + frame.width - (inner.x + inner.width)),
    bottom: Math.max(0, frame.y + frame.height - (inner.y + inner.height)),
    left: Math.max(0, inner.x - frame.x),
  }
}

/** The edges of `area` that the frame touches, to half a pixel. */
function edgesTouched(frame: Rect, area: Rect, screen: ScreenTree): Edge[] {
  const near = tolerance(screen)
  return EDGES.filter((edge) => {
    switch (edge) {
      case 'top':
        return frame.y <= area.y + near
      case 'left':
        return frame.x <= area.x + near
      case 'right':
        return frame.x + frame.width >= area.x + area.width - near
      case 'bottom':
        return frame.y + frame.height >= area.y + area.height - near
    }
  })
}

function screenRect(screen: ScreenTree): Rect {
  return { x: 0, y: 0, ...screen.display.size }
}

/**
 * The part of the screen that the tree covers: the top nodes, inside the
 * screen. On API 30 it is shorter than the screen along the long side
 * (round 5), and a node past it is cut there or has no size.
 */
function treeArea(screen: ScreenTree): Rect {
  const frames = screen.nodes
    .map((node) => intersection(node.frame, screenRect(screen)))
    .filter((frame): frame is Rect => frame !== null)
  if (frames.length === 0) return screenRect(screen)
  const x = Math.min(...frames.map((frame) => frame.x))
  const y = Math.min(...frames.map((frame) => frame.y))
  return {
    x,
    y,
    width: Math.max(...frames.map((frame) => frame.x + frame.width)) - x,
    height: Math.max(...frames.map((frame) => frame.y + frame.height)) - y,
  }
}

function name(node: UiNode): string {
  return describeElement(toElement(node))
}

/**
 * True for a node with text, a label or a touch that covers the whole
 * screen: a scrim, or the region that closes a menu on an outside press.
 * Where the tree ends short of the screen (API 30), it covers the tree.
 */
export function isOverlay(node: UiNode, screen: ScreenTree): boolean {
  return (
    matters(node) &&
    [screenRect(screen), treeArea(screen)].some(
      (area) => edgesTouched(node.frame, area, screen).length === EDGES.length,
    )
  )
}

/**
 * `inset`: an element with text, a label or a touch reaches past the safe
 * area into a bar or the cutout. Inside a scroll view, the edges along its
 * axis don't count: content scrolls under the bars on purpose. An overlay
 * (`isOverlay`) covers the insets on purpose, so only what it holds counts.
 */
export function checkInset(screen: CheckedScreen): RuleResult {
  const { size } = screen.display
  const { safeArea, cutoutRects } = screen.insets
  const safe = {
    x: safeArea.left,
    y: safeArea.top,
    width: size.width - safeArea.left - safeArea.right,
    height: size.height - safeArea.top - safeArea.bottom,
  }
  const near = tolerance(screen)
  const checked = place(screen).filter(
    ({ node }) =>
      matters(node) && onScreen(node, screen) && !isOverlay(node, screen),
  )

  const findings = checked.flatMap(({ node, scrollAxes }): Finding[] => {
    const reach = reachPast(node.frame, safe)
    const edges = EDGES.filter(
      (edge) => reach[edge] > near && !scrollAxes.has(AXIS_OF[edge]),
    )
    if (edges.length === 0) return []
    const overCutout = cutoutRects.some(
      (rect) => intersection(node.frame, rect) !== null,
    )
    const parts = edges.map(
      (edge) => `${round2(reach[edge])} dp into the ${edge} inset`,
    )
    return [
      {
        element: toElement(node),
        message: `${name(node)} reaches ${parts.join(' and ')}${overCutout ? ', over the cutout' : ''}.`,
        details: Object.fromEntries([
          ...edges.map((edge) => [edge, reach[edge]]),
          ...(overCutout ? [['cutout', 1]] : []),
        ]),
      },
    ]
  })
  return {
    rule: 'inset',
    passed: findings.length === 0,
    checked: checked.length,
    findings,
  }
}

/**
 * `touch-target`: an element that takes a touch is smaller than 48 dp on
 * an axis. On an axis where it touches the edge of the screen or of the
 * tree, uiautomator may have clipped it, so that axis doesn't count.
 */
export function checkTouchTarget(screen: CheckedScreen): RuleResult {
  const checked = place(screen).filter(
    ({ node }) =>
      (node.clickable || node.longClickable) && onScreen(node, screen),
  )
  const near = tolerance(screen)
  const areas = [screenRect(screen), treeArea(screen)]

  const findings = checked.flatMap(({ node }): Finding[] => {
    const clipped = new Set(
      areas
        .flatMap((area) => edgesTouched(node.frame, area, screen))
        .map((edge) => AXIS_OF[edge]),
    )
    const { width, height } = node.frame
    const small =
      (!clipped.has('x') && width < MIN_TOUCH_TARGET - near) ||
      (!clipped.has('y') && height < MIN_TOUCH_TARGET - near)
    if (!small) return []
    return [
      {
        element: toElement(node),
        message: `${name(node)} is ${round2(width)} × ${round2(height)} dp; a touch target needs ${MIN_TOUCH_TARGET} × ${MIN_TOUCH_TARGET} dp.`,
        details: { width, height, min: MIN_TOUCH_TARGET },
      },
    ]
  })
  return {
    rule: 'touch-target',
    passed: findings.length === 0,
    checked: checked.length,
    findings,
  }
}

/**
 * True when two frames sit in one row (for a left or right edge) or one
 * column (for a top or bottom edge): the same size across that line, to
 * 1 dp, and overlapping on it.
 */
function inLine(a: Rect, b: Rect, edge: Edge): boolean {
  const across: { start: 'x' | 'y'; size: 'width' | 'height' } =
    AXIS_OF[edge] === 'x'
      ? { start: 'y', size: 'height' }
      : { start: 'x', size: 'width' }
  const { start, size } = across
  return (
    Math.abs(a[size] - b[size]) <= 1 &&
    a[start] < b[start] + b[size] &&
    b[start] < a[start] + a[size]
  )
}

/** The size of a frame along the axis of an edge. */
function sizeAlong(frame: Rect, edge: Edge): number {
  return AXIS_OF[edge] === 'x' ? frame.width : frame.height
}

/**
 * `overflow`: an element is cut at an edge of the screen. uiautomator clips
 * each element to the screen, so loupe can tell only from the siblings: an
 * element that touches a screen edge and is shorter along that axis than
 * two or more siblings in its row (or column) of its type, which agree on
 * one size, is cut. Inside a scroll view, its axis doesn't count. On API 30
 * the tree can end before the screen edge; there this rule sees nothing.
 */
export function checkOverflow(screen: CheckedScreen): RuleResult {
  const checked = place(screen).filter(
    ({ node }) => matters(node) && onScreen(node, screen),
  )

  const findings = checked.flatMap(
    ({ node, siblings, scrollAxes }): Finding[] => {
      for (const edge of edgesTouched(node.frame, screenRect(screen), screen)) {
        if (scrollAxes.has(AXIS_OF[edge])) continue
        const sizes = siblings
          .filter(
            (sibling) =>
              sibling !== node &&
              sibling.type === node.type &&
              matters(sibling) &&
              onScreen(sibling, screen) &&
              inLine(node.frame, sibling.frame, edge),
          )
          .map((sibling) => sizeAlong(sibling.frame, edge))
        const full = Math.max(...sizes)
        const same = sizes.filter((size) => full - size <= 1).length
        const visible = sizeAlong(node.frame, edge)
        if (same >= 2 && visible < full - 1) {
          return [
            {
              element: toElement(node),
              message: `${name(node)} is cut at the ${edge} edge of the screen: ${round2(visible)} dp shows, and its siblings are ${round2(full)} dp.`,
              details: { visible, siblings: full },
            },
          ]
        }
      }
      return []
    },
  )
  return {
    rule: 'overflow',
    passed: findings.length === 0,
    checked: checked.length,
    findings,
  }
}

function everyNode(nodes: readonly UiNode[]): UiNode[] {
  return nodes.flatMap((node) => [node, ...everyNode(node.children ?? [])])
}

function toPixelRect(frame: Rect, scale: number): PixelRect {
  const x = Math.round(frame.x * scale)
  const y = Math.round(frame.y * scale)
  return {
    x,
    y,
    width: Math.round(rectRight(frame) * scale) - x,
    height: Math.round((frame.y + frame.height) * scale) - y,
  }
}

/**
 * The columns where the element shows, in dp: its ink in the screenshot,
 * with the other elements that draw over or under its frame masked. Its
 * frame when there is no screenshot, or no ink in it.
 */
function inkOf(
  node: UiNode,
  screen: CheckedScreen,
  drawn: readonly UiNode[],
): ColumnSpan {
  const { frame } = node
  const whole = { from: frame.x, to: rectRight(frame) }
  if (!screen.image) return whole
  const { scale } = screen.display
  const own = new Set(everyNode([node]))
  const masks = drawn
    .filter(
      (other) =>
        !own.has(other) &&
        intersection(other.frame, frame) !== null &&
        !containsRect(other.frame, frame, tolerance(screen)),
    )
    .map((other) => toPixelRect(other.frame, scale))
  const span = inkColumns(screen.image, toPixelRect(frame, scale), masks)
  return span ? { from: span.from / scale, to: span.to / scale } : whole
}

/** Where an element shows along x, what is beside it, and what holds it. */
interface Centring {
  ink: ColumnSpan
  /** The nearest element on each side, in its row. */
  left?: UiNode
  right?: UiNode
  /** The smallest element that holds it and those two. */
  container: UiNode
  /** Each element on each side, in its row, inside the container. */
  lefts: UiNode[]
  rights: UiNode[]
}

function centringOf(
  node: UiNode,
  screen: CheckedScreen,
  placed: readonly Placed[],
  drawn: readonly UiNode[],
): Centring | null {
  const near = tolerance(screen)
  const { frame } = node
  const ink = inkOf(node, screen, drawn)
  const own = new Set(everyNode([node]))
  const beside = placed
    .map((item) => item.node)
    .filter(
      (other) =>
        !own.has(other) &&
        matters(other) &&
        onScreen(other, screen) &&
        !containsRect(other.frame, frame, near) &&
        other.frame.y < frame.y + frame.height &&
        frame.y < other.frame.y + other.frame.height,
    )
  const lefts = beside.filter(
    (other) => rectRight(other.frame) <= ink.from + near,
  )
  const rights = beside.filter((other) => other.frame.x >= ink.to - near)
  const left = lefts.reduce<UiNode | undefined>(
    (best, other) =>
      !best || rectRight(other.frame) > rectRight(best.frame) ? other : best,
    undefined,
  )
  const right = rights.reduce<UiNode | undefined>(
    (best, other) => (!best || other.frame.x < best.frame.x ? other : best),
    undefined,
  )

  const held = [frame, left?.frame, right?.frame].filter(
    (rect): rect is Rect => rect !== undefined,
  )
  const area = (rect: Rect) => rect.width * rect.height
  const container = placed
    .map((item) => item.node)
    .filter(
      (other) =>
        !own.has(other) &&
        held.every((rect) => containsRect(other.frame, rect, near)),
    )
    .reduce<UiNode | undefined>(
      (best, other) =>
        !best || area(other.frame) < area(best.frame) ? other : best,
      undefined,
    )
  if (!container) return null

  const inside = (other: UiNode) =>
    containsRect(container.frame, other.frame, near)
  return {
    ink,
    left,
    right,
    container,
    lefts: lefts.filter(inside),
    rights: rights.filter(inside),
  }
}

/**
 * True when the frame ends where the tree ends, short of the screen: on
 * API 30 the tree can stop before the screen edge, and cut the frame there.
 */
function cutByTree(frame: Rect, screen: CheckedScreen): boolean {
  const area = treeArea(screen)
  const near = tolerance(screen)
  const shortLeft = area.x > near
  const shortRight = rectRight(area) < screen.display.size.width - near
  return (
    (shortLeft && frame.x <= area.x + near) ||
    (shortRight && rectRight(frame) >= rectRight(area) - near)
  )
}

/** From the container's centre to the ink's centre, in dp; negative is left. */
function offCentre({ ink, container }: Centring): number {
  const { x, width } = container.frame
  return (ink.from + ink.to) / 2 - (x + width / 2)
}

function describeOff(off: number, container: UiNode): string {
  return `${round2(Math.abs(off))} dp ${off < 0 ? 'left' : 'right'} of the centre of its container, ${name(container)}`
}

function centreDetails(
  centring: Centring,
  off: number,
): Record<string, number> {
  const { ink, container } = centring
  return {
    offCentre: off,
    centre: (ink.from + ink.to) / 2,
    containerCentre: container.frame.x + container.frame.width / 2,
  }
}

/**
 * `centred`: a text that sits between an element on its left and one on its
 * right, more than `CLEAR_GAP` from both, is aligned to neither, so it must
 * be at the centre of its container: the smallest element that holds it and
 * those two. Its place is its ink in the screenshot: a wide frame can hold
 * text centred in that frame, off the container's centre. A row of like
 * items (its type on both sides) and a horizontal scroll view are left out.
 * Each element in `options.centred` is checked against its container
 * whatever sits beside it.
 */
export function checkCentred(
  screen: CheckedScreen,
  options: CheckOptions = {},
): RuleResult {
  const placed = place(screen)
  const drawn = everyNode(screen.nodes)
  const findings: Finding[] = []
  const warnings: string[] = []
  let checked = 0

  const named = new Set(
    (options.centred ?? []).map((selector) =>
      findNode(
        screen.nodes,
        selector,
        screen.display.size,
        'Name one by another selector.',
      ),
    ),
  )
  for (const node of named) {
    const centring = centringOf(node, screen, placed, drawn)
    if (!centring) {
      warnings.push(
        `No element holds ${name(node)}, so it has no centre to be at.`,
      )
      continue
    }
    if (cutByTree(centring.container.frame, screen)) {
      warnings.push(
        `loupe can't find the centre of the container of ${name(node)}: the tree ends short of the screen there.`,
      )
      continue
    }
    checked += 1
    const off = offCentre(centring)
    if (Math.abs(off) > CENTRE_TOLERANCE) {
      findings.push({
        element: toElement(node),
        message: `${name(node)} is ${describeOff(off, centring.container)}.`,
        details: centreDetails(centring, off),
      })
    }
  }

  for (const { node, scrollAxes } of placed) {
    if (named.has(node) || !node.text || scrollAxes.has('x')) continue
    if (!onScreen(node, screen)) continue
    const centring = centringOf(node, screen, placed, drawn)
    if (!centring?.left || !centring.right) continue
    const { ink, left, right, lefts, rights, container } = centring
    const likeItems =
      lefts.some((other) => other.type === node.type) &&
      rights.some((other) => other.type === node.type)
    const leftGap = ink.from - rectRight(left.frame)
    const rightGap = right.frame.x - ink.to
    if (likeItems || leftGap <= CLEAR_GAP || rightGap <= CLEAR_GAP) continue
    if (cutByTree(container.frame, screen)) continue
    checked += 1
    const off = offCentre(centring)
    if (Math.abs(off) > CENTRE_TOLERANCE) {
      findings.push({
        element: toElement(node),
        message: `${name(node)} sits between ${name(left)} and ${name(right)}, clear of both, but ${describeOff(off, container)}.`,
        details: { ...centreDetails(centring, off), leftGap, rightGap },
      })
    }
  }

  return {
    rule: 'centred',
    passed: findings.length === 0,
    checked,
    findings,
    ...(warnings.length > 0 ? { warnings } : {}),
  }
}

/** `mirrored` finds an edge more than this from its mirrored place, in dp. */
export const MIRROR_TOLERANCE = 1

const KEYS = ['id', 'label', 'text'] as const

/**
 * Pairs each element here with the same element there: by id, else by
 * label, else by text; the value must be once on each screen.
 */
function pairs(
  here: readonly UiNode[],
  there: readonly UiNode[],
): [UiNode, UiNode][] {
  const counts = (nodes: readonly UiNode[], key: (typeof KEYS)[number]) => {
    const count = new Map<string, UiNode[]>()
    for (const node of nodes) {
      const value = node[key]
      if (value) count.set(value, [...(count.get(value) ?? []), node])
    }
    return count
  }
  const tables = KEYS.map((key) => ({
    key,
    here: counts(here, key),
    there: counts(there, key),
  }))
  return here.flatMap((node): [UiNode, UiNode][] => {
    for (const table of tables) {
      const value = node[table.key]
      if (!value) continue
      const mine = table.here.get(value) ?? []
      const theirs = table.there.get(value) ?? []
      if (mine.length === 1 && theirs.length === 1 && theirs[0]) {
        return [[node, theirs[0]]]
      }
    }
    return []
  })
}

/**
 * The left and right edges of a frame, or null for an edge that touches
 * the screen or the end of the tree: uiautomator clips a frame there, so
 * that edge isn't known.
 */
function knownEdges(
  frame: Rect,
  screen: ScreenTree,
): { left: number | null; right: number | null } {
  const touched = new Set(
    [screenRect(screen), treeArea(screen)].flatMap((area) =>
      edgesTouched(frame, area, screen),
    ),
  )
  return {
    left: touched.has('left') ? null : frame.x,
    right: touched.has('right') ? null : rectRight(frame),
  }
}

function describeSpan(from: number, to: number): string {
  return `${round2(from)}–${round2(to)} dp`
}

/** A place along x, with the edges that are known. */
interface Span {
  left: number
  right: number
  knownLeft: boolean
  knownRight: boolean
}

/**
 * `mirrored`: each element sits where the other layout direction puts it,
 * mirrored about the centre of the safe area: the cutout stays on its side
 * of the screen in both directions. An element that reaches into a side
 * inset in either direction ignores the safe area, so it can mirror about
 * the centre of the screen too (`inset` reports it). An element that the
 * other direction centres on the screen can stay where it is. Elements
 * pair up by id, label or text (once on each screen); an edge that touches
 * the screen or the end of the tree isn't compared.
 *
 * The rule can't tell which direction is wrong, so LTR (from the probe) is
 * the reference, and a finding is about the RTL screen; with no probe, the
 * saved screen is the reference.
 */
export function checkMirrored(
  screen: CheckedScreen,
  { mirrorOf }: CheckOptions = {},
): RuleResult {
  if (!mirrorOf) {
    throw new LoupeError(
      'invalid_input',
      'The mirrored rule needs the same screen in the other direction.',
    )
  }
  const near = tolerance(screen)
  const { width } = screen.display.size
  const { safeArea } = screen.insets
  const insideSafe = (frame: Rect) =>
    frame.x >= safeArea.left - near &&
    rectRight(frame) <= width - safeArea.right + near
  const elements = (tree: ScreenTree) =>
    place(tree)
      .map(({ node }) => node)
      .filter((node) => matters(node) && onScreen(node, tree))

  const liveIsReference =
    screen.direction === 'ltr' && mirrorOf.direction !== 'ltr'
  const [subject, reference] = liveIsReference
    ? [mirrorOf, screen]
    : [screen, mirrorOf]
  const labelOf = (tree: ScreenTree) =>
    tree.direction?.toUpperCase() ??
    (tree === screen ? 'this screen' : 'the saved screen')
  const there = labelOf(reference).replace(/^t/, 'T')
  const live = elements(screen)
  const saved = elements(mirrorOf)

  let checked = 0
  const findings = (
    liveIsReference ? pairs(saved, live) : pairs(live, saved)
  ).flatMap(([node, other]): Finding[] => {
    const from = other.frame.x
    const to = rectRight(other.frame)
    const otherEdges = knownEdges(other.frame, reference)
    const mirror = (centre: number): Span => ({
      left: 2 * centre - to,
      right: 2 * centre - from,
      knownLeft: otherEdges.right !== null,
      knownRight: otherEdges.left !== null,
    })
    const expected = mirror((safeArea.left + width - safeArea.right) / 2)
    const onCentre =
      otherEdges.left !== null &&
      otherEdges.right !== null &&
      Math.abs((from + to) / 2 - width / 2) <= MIRROR_TOLERANCE
    const candidates = [
      expected,
      ...(onCentre
        ? [{ left: from, right: to, knownLeft: true, knownRight: true }]
        : []),
      ...(!insideSafe(node.frame) || !insideSafe(other.frame)
        ? [mirror(width / 2)]
        : []),
    ]

    const edges = knownEdges(node.frame, subject)
    const offsets = (span: Span) => [
      ...(span.knownLeft && edges.left !== null
        ? [Math.abs(edges.left - span.left)]
        : []),
      ...(span.knownRight && edges.right !== null
        ? [Math.abs(edges.right - span.right)]
        : []),
    ]
    if (offsets(expected).length === 0) return []
    checked += 1
    const fits = candidates.some((span) =>
      offsets(span).every((off) => off <= MIRROR_TOLERANCE),
    )
    if (fits) return []
    return [
      {
        element: toElement(node),
        message: `${name(node)} sits at ${describeSpan(node.frame.x, rectRight(node.frame))} in ${labelOf(subject)}. ${there} puts it at ${describeSpan(from, to)}, so mirrored it belongs at ${describeSpan(expected.left, expected.right)}.`,
        details: {
          from: node.frame.x,
          to: rectRight(node.frame),
          expectedFrom: expected.left,
          expectedTo: expected.right,
          referenceFrom: from,
          referenceTo: to,
        },
      },
    ]
  })

  return {
    rule: 'mirrored',
    passed: findings.length === 0,
    checked,
    findings,
  }
}

export const RULE_CHECKS: Record<
  RuleName,
  (screen: CheckedScreen, options?: CheckOptions) => RuleResult
> = {
  inset: checkInset,
  overflow: checkOverflow,
  centred: checkCentred,
  'touch-target': checkTouchTarget,
  mirrored: checkMirrored,
}

/** The rules of a comma list, such as "inset,overflow". */
export function rulesOf(text: string | undefined): RuleName[] {
  if (text === undefined) return [...RULES]
  const names = text.split(',').map((part) => part.trim())
  const unknown = names.filter(
    (part) => !(RULES as readonly string[]).includes(part),
  )
  if (unknown.length > 0 || names.length === 0) {
    throw new LoupeError(
      'invalid_input',
      `${unknown.map((part) => JSON.stringify(part)).join(', ')} isn't a rule. The rules: ${RULES.join(', ')}.`,
    )
  }
  return [...new Set(names as RuleName[])]
}

/** One line for each rule, and one for each finding, for a person. */
export function describeResults(results: readonly RuleResult[]): string[] {
  return results.flatMap(({ rule, passed, checked, findings, warnings }) => [
    `${rule}: ${passed ? 'pass' : 'fail'} (${checked} elements${passed ? '' : `, ${findings.length} findings`})`,
    ...findings.map((finding) => `  ${finding.message}`),
    ...(warnings ?? []).map((warning) => `  Warning: ${warning}`),
  ])
}
