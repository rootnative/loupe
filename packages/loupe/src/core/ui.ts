import { z } from 'zod'
import { type Platform, round2 } from './units'

export const rectSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
})

/** A state shows only when it's true, to keep the tree short. */
const state = z.literal(true).optional()

export const uiNodeSchema = z.object({
  type: z
    .string()
    .describe('The class of the view, for example android.widget.TextView.'),
  text: z.string().optional(),
  label: z
    .string()
    .optional()
    .describe('The accessibility label: content-desc on Android.'),
  id: z.string().optional().describe('The resource-id on Android.'),
  hint: z.string().optional(),
  frame: rectSchema.describe(
    'In dp (pt on iOS), from the top-left corner of the screen.',
  ),
  clickable: state,
  longClickable: state,
  checkable: state,
  checked: state,
  focusable: state,
  focused: state,
  scrollable: state,
  selected: state,
  password: state,
  disabled: state,
  get children(): z.ZodOptional<z.ZodArray<typeof uiNodeSchema>> {
    return z.array(uiNodeSchema).optional()
  },
})

export type UiNode = z.infer<typeof uiNodeSchema>

export type Axis = 'x' | 'y'

const EXPO_GO_ANDROID = 'host.exp.exponent'

/**
 * True for a view of the app itself in an Android tree: its class is
 * `android.*`. A node of another class in Expo Go is Expo Go's own.
 */
function isAndroidView(node: UiNode): boolean {
  return node.type.startsWith('android.')
}

/**
 * True for the root of Expo Go's own overlay (the "Tools" button and its
 * label) when the app is Expo Go. A fresh Expo Go shows the label for a few
 * seconds, so the overlay can change while the app keeps still. On Android
 * it's a node whose class isn't `android.*`: the app's views are all
 * `android.*`. Only the Android tree marks it: an iOS tree gives false.
 */
export function isExpoGoOverlay(
  node: UiNode,
  app: string | undefined,
  platform: Platform,
): boolean {
  return (
    platform === 'android' && app === EXPO_GO_ANDROID && !isAndroidView(node)
  )
}

/**
 * The axis of a scroll view. On Android it scrolls along x when its class
 * says so, else along y. Only the Android tree names the axis: on iOS each
 * scroll view counts as one along y.
 */
export function scrollAxisOf(node: UiNode, platform: Platform): Axis {
  return platform === 'android' &&
    /HorizontalScrollView|ViewPager/.test(node.type)
    ? 'x'
    : 'y'
}

function describeNode(node: UiNode): string {
  const { x, y, width, height } = node.frame
  const parts = [node.type.slice(node.type.lastIndexOf('.') + 1)]
  if (node.id) parts.push(`#${node.id}`)
  if (node.text) parts.push(JSON.stringify(node.text))
  if (node.label) parts.push(`label ${JSON.stringify(node.label)}`)
  parts.push(
    `(${round2(x)}, ${round2(y)}) ${round2(width)} × ${round2(height)}`,
  )
  return parts.join(' ')
}

/** An outline for a person: one line for each node, indented by depth. */
export function describeUiTree(nodes: readonly UiNode[]): string[] {
  const lines: string[] = []
  const walk = (node: UiNode, depth: number): void => {
    lines.push(`${'  '.repeat(depth)}${describeNode(node)}`)
    for (const child of node.children ?? []) walk(child, depth + 1)
  }
  for (const node of nodes) walk(node, 0)
  return lines
}
