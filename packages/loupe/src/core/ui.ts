import { z } from 'zod'
import { round2 } from './units'

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

/** A scroll view scrolls along x when its class says so, else along y. */
export function scrollAxisOf(node: UiNode): Axis {
  return /HorizontalScrollView|ViewPager/.test(node.type) ? 'x' : 'y'
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
