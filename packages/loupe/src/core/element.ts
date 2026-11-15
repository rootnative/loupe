import { z } from 'zod'
import { LoupeError } from './errors'
import { rectSchema, type UiNode } from './ui'
import {
  intersection,
  type Point,
  type Rect,
  rectCentre,
  round2,
  type Size,
} from './units'

const SUGGESTIONS = 5

export const selectorFields = {
  text: z
    .string()
    .min(1)
    .optional()
    .describe('Touch the element with this text: the whole text, not a part.'),
  label: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Touch the element with this accessibility label (content-desc on Android).',
    ),
  id: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Touch the element with this id: the resource-id on Android, or the part after ":id/".',
    ),
}

export type Selector =
  | { by: 'text'; value: string }
  | { by: 'label'; value: string }
  | { by: 'id'; value: string }

export type TouchTarget =
  | { point: Point; selector?: undefined }
  | { point?: undefined; selector: Selector }

interface TargetInput {
  x?: number
  y?: number
  text?: string
  label?: string
  id?: string
}

/** The point or the element that the input names. It must name one. */
export function targetOf({ x, y, text, label, id }: TargetInput): TouchTarget {
  const selectors: Selector[] = [
    ...(text === undefined ? [] : [{ by: 'text', value: text } as const]),
    ...(label === undefined ? [] : [{ by: 'label', value: label } as const]),
    ...(id === undefined ? [] : [{ by: 'id', value: id } as const]),
  ]
  const hasPoint = x !== undefined || y !== undefined
  const [selector] = selectors

  if (hasPoint && selectors.length === 0) {
    if (x === undefined || y === undefined) {
      throw new LoupeError('invalid_input', 'A point needs both x and y.')
    }
    return { point: { x, y } }
  }
  if (!hasPoint && selector && selectors.length === 1) return { selector }
  throw new LoupeError(
    'invalid_input',
    'Name one target: a point (x and y), or one of text, label and id.',
  )
}

export const elementSchema = z.object({
  type: z.string(),
  text: z.string().optional(),
  label: z.string().optional(),
  id: z.string().optional(),
  frame: rectSchema.describe('In dp (pt on iOS).'),
})

export type Element = z.infer<typeof elementSchema>

function valueOf(node: UiNode, by: Selector['by']): string | undefined {
  return node[by]
}

function matches(node: UiNode, { by, value }: Selector): boolean {
  const own = valueOf(node, by)
  if (own === value) return true
  // A native view's resource-id has the package in front: com.example:id/title.
  return by === 'id' && own?.endsWith(`:id/${value}`) === true
}

function everyNode(nodes: readonly UiNode[]): UiNode[] {
  return nodes.flatMap((node) => [node, ...everyNode(node.children ?? [])])
}

function describeFrame({ x, y, width, height }: Rect): string {
  return `(${round2(x)}, ${round2(y)}) ${round2(width)} × ${round2(height)}`
}

function describeSelector({ by, value }: Selector): string {
  return `${by} ${JSON.stringify(value)}`
}

function notFound(all: readonly UiNode[], selector: Selector): LoupeError {
  const query = selector.value.toLowerCase()
  const close = [
    ...new Set(
      all
        .map((node) => valueOf(node, selector.by))
        .filter((own): own is string =>
          Boolean(own?.toLowerCase().includes(query)),
        ),
    ),
  ].slice(0, SUGGESTIONS)
  const hint =
    close.length > 0
      ? ` Close ones: ${close.map((own) => JSON.stringify(own)).join(', ')}.`
      : ''
  return new LoupeError(
    'element_not_found',
    `No element on the screen has the ${describeSelector(selector)}.${hint}`,
  )
}

export interface FoundElement {
  element: Element
  /** The centre of the part of the element that is on the screen, in dp. */
  point: Point
}

/**
 * Finds the one element that the selector names, and the point to touch:
 * the centre of the part that is on the screen. Exactly one element must be
 * on the screen.
 */
export function findElement(
  nodes: readonly UiNode[],
  selector: Selector,
  screen: Size,
): FoundElement {
  const all = everyNode(nodes)
  const found = all.filter((node) => matches(node, selector))
  if (found.length === 0) throw notFound(all, selector)

  const screenRect = { x: 0, y: 0, ...screen }
  const visible = found.flatMap((node) => {
    const part = intersection(node.frame, screenRect)
    return part ? [{ node, part }] : []
  })
  const [first] = visible

  if (!first) {
    throw new LoupeError(
      'element_not_found',
      `The element with the ${describeSelector(selector)} is in the tree, but not on the screen. Scroll it into view first.`,
    )
  }
  if (visible.length > 1) {
    const list = visible
      .slice(0, SUGGESTIONS)
      .map(({ node }) => `${node.type} at ${describeFrame(node.frame)}`)
    throw new LoupeError(
      'element_ambiguous',
      `${visible.length} elements on the screen have the ${describeSelector(selector)}: ${list.join('; ')}. Touch one by its point, or by another selector.`,
    )
  }

  const { type, text, label, id, frame } = first.node
  return {
    element: { type, text, label, id, frame },
    point: rectCentre(first.part),
  }
}

/** A short name for an element in a summary line. */
export function describeElement({ type, text, label, id }: Element): string {
  if (text) return JSON.stringify(text)
  if (label) return `label ${JSON.stringify(label)}`
  if (id) return `#${id}`
  return type.slice(type.lastIndexOf('.') + 1)
}
