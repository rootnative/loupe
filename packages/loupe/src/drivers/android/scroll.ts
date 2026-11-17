import { type DisplayState } from '../../core/display'
import {
  type Element,
  elementsOnScreen,
  findElement,
  type Selector,
} from '../../core/element'
import { LoupeError } from '../../core/errors'
import {
  cutAtIncomingEdge,
  NUDGE_SHARE,
  type ScrollDirection,
  scrollStroke,
  scrollViewFor,
  viewContent,
} from '../../core/scroll'
import { type UiNode } from '../../core/ui'
import { intersection } from '../../core/units'
import { type AndroidTarget } from './devices'
import { dragAndroid } from './gesture'
import { readAndroidUi } from './ui'

/**
 * The timing of one scroll. The touch holds still before it lifts, so
 * Android sees no speed and the list doesn't fling past the element.
 */
const STROKE = { duration: 300, holdStart: 0, holdEnd: 250 }

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
    const before = viewContent(ui.nodes, next.frame)
    const { from, to } = scrollStroke(next.frame, direction, share)
    await dragAndroid(target, from, to, STROKE, app)
    scrolls += 1
    ui = await readAndroidUi(target, app)
    ended = viewContent(ui.nodes, next.frame) === before
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
    await scroll()
  }
}
