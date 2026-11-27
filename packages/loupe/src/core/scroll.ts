import { findNode } from './element'
import { LoupeError } from './errors'
import { type Axis, isExpoGoOverlay, scrollAxisOf, type UiNode } from './ui'
import {
  intersection,
  type Point,
  type Rect,
  rectBottom,
  type Platform,
  rectRight,
  type Size,
} from './units'

/** Where new content comes from: `down` shows what is below. */
export const DIRECTIONS = ['down', 'up', 'left', 'right'] as const

export type ScrollDirection = (typeof DIRECTIONS)[number]

export function axisOf(direction: ScrollDirection): Axis {
  return direction === 'down' || direction === 'up' ? 'y' : 'x'
}

/** The share of the scroll view that one scroll moves. */
export const SCROLL_SHARE = 0.6

/** The share of the last, short scroll that brings a cut element in. */
export const NUDGE_SHARE = 0.3

function everyNode(nodes: readonly UiNode[]): UiNode[] {
  return nodes.flatMap((node) => [node, ...everyNode(node.children ?? [])])
}

function area({ width, height }: Rect): number {
  return width * height
}

/**
 * The scroll view to drag. With an id, that element, which must scroll.
 * Else the scroll views on the screen whose class scrolls along the
 * direction (all of them when none does), without one of those inside it:
 * the largest of these. Null when the screen has no scroll view.
 */
export function scrollViewFor(
  nodes: readonly UiNode[],
  direction: ScrollDirection,
  screen: Size,
  platform: Platform,
  id?: string,
): UiNode | null {
  if (id !== undefined) {
    const named = findNode(
      nodes,
      { by: 'id', value: id },
      screen,
      'Name the scroll view by another id.',
    )
    if (!named.scrollable) {
      throw new LoupeError(
        'element_not_found',
        `The element with the id ${JSON.stringify(id)} doesn't scroll.`,
      )
    }
    return named
  }

  const screenRect = { x: 0, y: 0, ...screen }
  const scrollers = everyNode(nodes).filter(
    (node) =>
      node.scrollable &&
      node.frame.width > 0 &&
      node.frame.height > 0 &&
      intersection(node.frame, screenRect) !== null,
  )
  const along = scrollers.filter(
    (node) => scrollAxisOf(node, platform) === axisOf(direction),
  )
  const candidates = along.length > 0 ? along : scrollers
  const innermost = candidates.filter((node) => {
    const inside = new Set(everyNode(node.children ?? []))
    return !candidates.some((other) => inside.has(other))
  })
  return innermost.reduce<UiNode | null>(
    (best, node) =>
      !best || area(node.frame) > area(best.frame) ? node : best,
    null,
  )
}

/**
 * The start and the end of a drag that scrolls `frame` by `share` of its
 * length, centred in it. To show what is below, the touch moves up.
 */
export function scrollStroke(
  frame: Rect,
  direction: ScrollDirection,
  share = SCROLL_SHARE,
): { from: Point; to: Point } {
  const start = 0.5 + share / 2
  const end = 0.5 - share / 2
  const along = (at: number): Point =>
    axisOf(direction) === 'y'
      ? { x: frame.x + frame.width / 2, y: frame.y + frame.height * at }
      : { x: frame.x + frame.width * at, y: frame.y + frame.height / 2 }
  return direction === 'down' || direction === 'right'
    ? { from: along(start), to: along(end) }
    : { from: along(end), to: along(start) }
}

/**
 * What the scroll view shows, as text: each node that has a part in
 * `frame`, with its frame. Two equal readings mean the view didn't move.
 * In Expo Go (`app`), its own overlay doesn't count.
 */
export function viewContent(
  nodes: readonly UiNode[],
  frame: Rect,
  platform: Platform,
  app?: string,
): string {
  const rows: unknown[][] = []
  const walk = (list: readonly UiNode[]) => {
    for (const node of list) {
      if (isExpoGoOverlay(node, app, platform)) continue
      if (intersection(node.frame, frame) !== null) {
        const { type, text, label, id } = node
        const { x, y, width, height } = node.frame
        rows.push([type, text, label, id, x, y, width, height])
      }
      walk(node.children ?? [])
    }
  }
  walk(nodes)
  return JSON.stringify(rows)
}

/**
 * True when the element touches the edge of the scroll view where new
 * content comes in: the view can cut it there.
 */
export function cutAtIncomingEdge(
  element: Rect,
  view: Rect,
  direction: ScrollDirection,
  tolerance: number,
): boolean {
  switch (direction) {
    case 'down':
      return rectBottom(element) >= rectBottom(view) - tolerance
    case 'up':
      return element.y <= view.y + tolerance
    case 'right':
      return rectRight(element) >= rectRight(view) - tolerance
    case 'left':
      return element.x <= view.x + tolerance
  }
}
