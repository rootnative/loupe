import { type DisplayState } from '../../core/display'
import {
  type Element,
  elementsOnScreen,
  findElement,
  type Selector,
} from '../../core/element'
import { LoupeError, throwIfCancelled } from '../../core/errors'
import {
  cutAtIncomingEdge,
  NUDGE_SHARE,
  type ScrollDirection,
  scrollStroke,
  scrollViewFor,
  viewContent,
} from '../../core/scroll'
import { scrollAxisOf, type UiNode } from '../../core/ui'
import { intersection, type Rect } from '../../core/units'
import { type AndroidTarget } from './devices'
import { dragAndroid } from './gesture'
import { swipeAndroid } from './touch'
import { readAndroidUi } from './ui'

/**
 * The timing of one scroll. The touch holds still before it lifts, so
 * Android sees no speed and the list doesn't fling past the element.
 */
const STROKE = { duration: 300, holdStart: 0, holdEnd: 250 }

/** A swipe this fast lets the list fling on after the lift. */
const FLING_MS = 100

/** The most fast swipes that bring a scroll view back to its top. */
const MAX_FLINGS = 3

export interface ScrollOptions {
  direction: ScrollDirection
  /** The most drags, the short last one included. */
  maxScrolls: number
  /** The id of the scroll view to drag. */
  in?: string
}

export interface ScrollTo {
  display: DisplayState
  element: Element
  scrolls: number
  /** The scroll view of the last drag. Left out with no drag. */
  scrollView?: Element
}

function toElement({ type, text, label, id, frame }: UiNode): Element {
  return { type, text, label, id, frame }
}

function describeSelector({ by, value }: Selector): string {
  return `${by} ${JSON.stringify(value)}`
}

function drags(count: number): string {
  return `${count} ${count === 1 ? 'drag' : 'drags'}`
}

/**
 * Drags the scroll view until the element shows, then once more by a
 * short way when the view cuts it at the edge where content comes in.
 * It stops when a drag doesn't change what the view shows: the end.
 */
export async function scrollToAndroid(
  target: AndroidTarget,
  selector: Selector,
  options: ScrollOptions,
  app?: string,
): Promise<ScrollTo> {
  const { direction, maxScrolls } = options
  let ui = await readAndroidUi(target, app)
  let scrolls = 0
  let view: UiNode | undefined
  let nudged = false
  let ended = false

  const scroll = async (share?: number) => {
    const next = scrollViewFor(ui.nodes, direction, ui.display.size, options.in)
    if (!next) {
      throw new LoupeError(
        'element_not_found',
        `The element with the ${describeSelector(selector)} isn't on the screen, and no scroll view on the screen scrolls ${direction}.`,
      )
    }
    view = next
    const before = viewContent(ui.nodes, next.frame, app)
    const { from, to } = scrollStroke(next.frame, direction, share)
    await dragAndroid(target, from, to, STROKE, app)
    scrolls += 1
    ui = await readAndroidUi(target, app)
    ended = viewContent(ui.nodes, next.frame, app) === before
  }

  for (;;) {
    if (elementsOnScreen(ui.nodes, selector, ui.display.size).length > 0) {
      const { element } = findElement(
        ui.nodes,
        selector,
        ui.display.size,
        'Scroll to one by another selector.',
      )
      const around =
        view ?? scrollViewFor(ui.nodes, direction, ui.display.size, options.in)
      const cut =
        around !== null &&
        intersection(element.frame, around.frame) !== null &&
        cutAtIncomingEdge(
          element.frame,
          around.frame,
          direction,
          0.5 / ui.display.scale,
        )
      if (cut && !nudged && !ended && scrolls < maxScrolls) {
        nudged = true
        await scroll(NUDGE_SHARE)
        continue
      }
      return {
        display: ui.display,
        element,
        scrolls,
        ...(view ? { scrollView: toElement(view) } : {}),
      }
    }
    if (ended) {
      throw new LoupeError(
        'element_not_found',
        `The element with the ${describeSelector(selector)} didn't show: the scroll view stopped moving after ${drags(scrolls)} ${direction}.`,
      )
    }
    if (scrolls >= maxScrolls) {
      throw new LoupeError(
        'element_not_found',
        `The element with the ${describeSelector(selector)} didn't show after ${drags(scrolls)} ${direction}. Give a higher max-scrolls to go on.`,
      )
    }
    throwIfCancelled(target.signal)
    await scroll()
  }
}

export interface ScrolledOnce {
  /** The frame of the scroll view. */
  frame: Rect
  /** What the view showed before the scroll, from `viewContent`. */
  top: string
}

/**
 * Drags the largest vertical scroll view down by one stroke, as
 * `scroll-to` does. Gives undefined when the screen has none, or when the
 * view shows the same after the drag.
 */
export async function scrollOnceAndroid(
  target: AndroidTarget,
  app?: string,
): Promise<ScrolledOnce | undefined> {
  const ui = await readAndroidUi(target, app)
  const view = scrollViewFor(ui.nodes, 'down', ui.display.size)
  if (!view || scrollAxisOf(view) !== 'y') return undefined

  const top = viewContent(ui.nodes, view.frame, app)
  const { from, to } = scrollStroke(view.frame, 'down')
  await dragAndroid(target, from, to, STROKE, app)
  const after = await readAndroidUi(target, app)
  return viewContent(after.nodes, view.frame, app) === top
    ? undefined
    : { frame: view.frame, top }
}

/**
 * Swipes fast toward the top until the view shows what it showed before
 * the scroll, `MAX_FLINGS` times at most, and less when the view stops
 * moving. Gives a warning when the top doesn't come back.
 */
export async function flingToTopAndroid(
  target: AndroidTarget,
  { frame, top }: ScrolledOnce,
  app?: string,
): Promise<string[]> {
  const { from, to } = scrollStroke(frame, 'up')
  let shown: string | undefined
  let flings = 0
  while (flings < MAX_FLINGS) {
    await swipeAndroid(target, from, to, FLING_MS, app)
    flings += 1
    const now = viewContent(
      (await readAndroidUi(target, app)).nodes,
      frame,
      app,
    )
    if (now === top) return []
    if (now === shown) break
    shown = now
  }
  return [
    `The scroll view didn't show its top again after ${flings} fast ${flings === 1 ? 'swipe' : 'swipes'} up, so the next check of this link can start lower down.`,
  ]
}
