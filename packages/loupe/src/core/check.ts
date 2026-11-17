import { z } from 'zod'
import { type DisplayState } from './display'
import { describeElement, type Element, elementSchema } from './element'
import { LoupeError } from './errors'
import { EDGES, type Edge, type InsetsReading } from './insets'
import { type UiNode } from './ui'
import { intersection, type Rect, round2 } from './units'

export const RULES = ['inset', 'overflow', 'touch-target'] as const

export type RuleName = (typeof RULES)[number]

/** The smallest touch target on Android, in dp (48 × 48). */
export const MIN_TOUCH_TARGET = 48

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
})

export type RuleResult = z.infer<typeof ruleResultSchema>

/** One screen, as the rules see it. Sizes in dp. */
export interface CheckedScreen {
  display: DisplayState
  /** The package of the window in the tree. */
  app?: string
  nodes: readonly UiNode[]
  insets: InsetsReading
}

type Axis = 'x' | 'y'

/** One node, with what the rules need to know about where it sits. */
interface Placed {
  node: UiNode
  siblings: readonly UiNode[]
  /** The axes of the scroll views around it. */
  scrollAxes: ReadonlySet<Axis>
}

const EXPO_GO = 'host.exp.exponent'

/** A scroll view scrolls along x when its class says so, else along y. */
function scrollAxisOf(node: UiNode): Axis {
  return /HorizontalScrollView|ViewPager/.test(node.type) ? 'x' : 'y'
}

/**
 * Each node that the rules can look at. In Expo Go, its own overlay (the
 * "Tools" button) sits in a subtree under a class that isn't `android.*`;
 * the app's views are all `android.*`, so that subtree is left out.
 */
function place(screen: CheckedScreen): Placed[] {
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
function onScreen(node: UiNode, screen: CheckedScreen): boolean {
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
function tolerance(screen: CheckedScreen): number {
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
function edgesTouched(frame: Rect, area: Rect, screen: CheckedScreen): Edge[] {
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

function screenRect(screen: CheckedScreen): Rect {
  return { x: 0, y: 0, ...screen.display.size }
}

/**
 * The part of the screen that the tree covers: the top nodes, inside the
 * screen. On API 30 it is shorter than the screen along the long side
 * (round 5), and a node past it is cut there or has no size.
 */
function treeArea(screen: CheckedScreen): Rect {
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
 * `inset`: an element with text, a label or a touch reaches past the safe
 * area into a bar or the cutout. Inside a scroll view, the edges along its
 * axis don't count: content scrolls under the bars on purpose.
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
    ({ node }) => matters(node) && onScreen(node, screen),
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

export const RULE_CHECKS: Record<
  RuleName,
  (screen: CheckedScreen) => RuleResult
> = {
  inset: checkInset,
  overflow: checkOverflow,
  'touch-target': checkTouchTarget,
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
  return results.flatMap(({ rule, passed, checked, findings }) => [
    `${rule}: ${passed ? 'pass' : 'fail'} (${checked} elements${passed ? '' : `, ${findings.length} findings`})`,
    ...findings.map((finding) => `  ${finding.message}`),
  ])
}
