import { type Element, findElement, type TouchTarget } from '../../core/element'
import { type Point } from '../../core/units'
import { type AndroidTarget } from './devices'
import { readAndroidUi } from './ui'

export interface Aim {
  /** In dp. */
  point: Point
  /** The element that the point is on, when the input named one. */
  element?: Element
}

/**
 * The point to touch: the one in the input, or the centre of the element
 * that the `ui` tree shows for the selector. Reading the tree runs the
 * foreground guard (see `readAndroidUi`).
 */
export async function aimAndroid(
  target: AndroidTarget,
  touchTarget: TouchTarget,
  app?: string,
): Promise<Aim> {
  if (touchTarget.point) return { point: touchTarget.point }
  const ui = await readAndroidUi(target, app)
  return findElement(ui.nodes, touchTarget.selector, ui.display.size)
}
