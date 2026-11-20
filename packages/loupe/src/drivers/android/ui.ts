import { type DisplayState } from '../../core/display'
import { LoupeError } from '../../core/errors'
import { isProbeLabel, type ProbeReading, readProbe } from '../../core/probe'
import { type UiNode } from '../../core/ui'
import { type Rect, rectFromPixels } from '../../core/units'
import { type AndroidTarget } from './devices'
import { toDisplayState } from './display'
import { whileInFront } from './foreground'
import {
  parseUiautomatorDump,
  parseUiautomatorWindows,
  type UiautomatorDump,
  type WindowDisplay,
} from './parse'
import { type XmlElement } from './xml'

const BOUNDS = /^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/
const MESSAGE_LIMIT = 200

export interface AndroidUi {
  /** Read just before the dump. */
  display: DisplayState
  /** The package of the window in the tree. */
  app?: string
  /** With no probe node: the probe is loupe's, not part of the app. */
  nodes: UiNode[]
  /** Left out when the screen has no probe. */
  probe?: ProbeReading
}

function frameOf(element: XmlElement, scale: number): Rect {
  const match = BOUNDS.exec(element.attributes.bounds ?? '')
  if (!match) {
    throw new LoupeError(
      'tool_failed',
      `uiautomator gave a node with no bounds: "${element.attributes.bounds ?? ''}".`,
    )
  }
  const [, left = 0, top = 0, right = 0, bottom = 0] = match.map(Number)
  return rectFromPixels(
    { x: left, y: top, width: right - left, height: bottom - top },
    scale,
  )
}

/**
 * The `node` elements as `UiNode`s, with no probe node. The label of each
 * probe node goes into `probeLabels`, in tree order.
 */
function toNodes(
  elements: readonly XmlElement[],
  scale: number,
  probeLabels: string[],
): UiNode[] {
  const nodes: UiNode[] = []
  for (const element of elements) {
    if (element.name !== 'node') continue
    const label = element.attributes['content-desc']
    if (isProbeLabel(label)) {
      probeLabels.push(label)
    } else {
      nodes.push(toNode(element, scale, probeLabels))
    }
  }
  return nodes
}

function toNode(
  element: XmlElement,
  scale: number,
  probeLabels: string[],
): UiNode {
  const attributes = element.attributes
  const state = (name: string): true | undefined =>
    attributes[name] === 'true' ? true : undefined
  const children = toNodes(element.children, scale, probeLabels)

  return {
    type: attributes.class ?? '',
    text: attributes.text || undefined,
    label: attributes['content-desc'] || undefined,
    id: attributes['resource-id'] || undefined,
    hint: attributes.hint || undefined,
    frame: frameOf(element, scale),
    clickable: state('clickable'),
    longClickable: state('long-clickable'),
    checkable: state('checkable'),
    checked: state('checked'),
    focusable: state('focusable'),
    focused: state('focused'),
    scrollable: state('scrollable'),
    selected: state('selected'),
    password: state('password'),
    disabled: attributes.enabled === 'false' ? true : undefined,
    children: children.length > 0 ? children : undefined,
  }
}

function readDump<T>(
  target: AndroidTarget,
  output: string,
  parse: (text: string) => T | undefined,
): T {
  let dump: T | undefined
  try {
    dump = parse(output)
  } catch (error) {
    throw new LoupeError(
      'tool_failed',
      `loupe can't read the tree that uiautomator gave on ${target.serial}. ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (dump) return dump

  if (output.includes('could not get idle state')) {
    throw new LoupeError(
      'not_idle',
      `The screen of ${target.serial} didn't keep still, so uiautomator can't read the tree. An animation that never stops can cause this. Take a screenshot instead, or stop the animation.`,
    )
  }
  const line = output
    .split(/\r?\n/)
    .map((text) => text.trim())
    .find(Boolean)
  throw new LoupeError(
    'tool_failed',
    line
      ? `uiautomator on ${target.serial} gave no tree: ${line.slice(0, MESSAGE_LIMIT)}`
      : `uiautomator on ${target.serial} gave no tree.`,
  )
}

/**
 * Reads the tree of the window in front with `uiautomator dump`, only while
 * `app` is in front (see `whileInFront`). uiautomator waits until the screen
 * keeps still, so an animation that never stops gives `not_idle`. The
 * probe's node isn't in the tree; its report is in `probe`.
 */
export async function readAndroidUi(
  target: AndroidTarget,
  app?: string,
): Promise<AndroidUi> {
  const { value: output, display } = await whileInFront(target, app, () =>
    dumpTree(target),
  )
  return treeOf(target, output, display)
}

/**
 * Reads the tree with no foreground check. Use it only for a window that
 * loupe knows by its focus, such as a system dialog, which has no app to
 * check.
 */
export async function readWindowTree(
  target: AndroidTarget,
  display: WindowDisplay,
): Promise<AndroidUi> {
  return treeOf(target, await dumpTree(target), display)
}

export interface UiWindow {
  /** As uiautomator names it, for example `TYPE_INPUT_METHOD`. */
  type: string
  title: string
  nodes: UiNode[]
}

/**
 * Reads the tree of each window on the screen, from the top, with
 * `uiautomator dump --windows` and no foreground check. Use it only for a
 * window that the plain dump leaves out, such as a sheet of the keyboard.
 */
export async function readEachWindow(
  target: AndroidTarget,
  display: WindowDisplay,
): Promise<{ display: DisplayState; windows: UiWindow[] }> {
  const output = await target.adb.text([
    'exec-out',
    'uiautomator',
    'dump',
    '--windows',
    '/dev/tty',
  ])
  const dumps = readDump(target, output, parseUiautomatorWindows)
  for (const dump of dumps) checkRotation(dump, display)

  const state = toDisplayState(display)
  return {
    display: state,
    windows: dumps.map(({ type, title, nodes }) => ({
      type,
      title,
      nodes: toNodes(nodes, state.scale, []),
    })),
  }
}

function dumpTree(target: AndroidTarget): Promise<string> {
  return target.adb.text(['exec-out', 'uiautomator', 'dump', '/dev/tty'])
}

function checkRotation(dump: UiautomatorDump, display: WindowDisplay): void {
  if (dump.rotation !== undefined && dump.rotation !== display.rotation) {
    throw new LoupeError(
      'tool_failed',
      `The screen turned during the dump. Wait until it's still, then try again.`,
    )
  }
}

function treeOf(
  target: AndroidTarget,
  output: string,
  display: WindowDisplay,
): AndroidUi {
  const dump = readDump(target, output, parseUiautomatorDump)
  checkRotation(dump, display)

  const state = toDisplayState(display)
  const probeLabels: string[] = []
  const nodes = toNodes(dump.nodes, state.scale, probeLabels)
  return {
    display: state,
    app: dump.nodes[0]?.attributes.package || undefined,
    nodes,
    probe: readProbe(probeLabels),
  }
}
