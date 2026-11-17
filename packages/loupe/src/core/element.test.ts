import { describe, expect, it } from 'vitest'
import { describeElement, findElement, targetOf } from './element'
import { type UiNode } from './ui'

const SCREEN = { width: 400, height: 800 }

function errorOf(run: () => unknown): unknown {
  try {
    run()
  } catch (error) {
    return error
  }
  return undefined
}

function node(fields: Partial<UiNode>, children?: UiNode[]): UiNode {
  return {
    type: 'android.widget.TextView',
    frame: { x: 0, y: 0, width: 100, height: 40 },
    ...fields,
    children,
  }
}

describe('targetOf', () => {
  it('takes a point, or one selector', () => {
    expect(targetOf({ x: 10, y: 20 })).toEqual({ point: { x: 10, y: 20 } })
    expect(targetOf({ text: 'OK' })).toEqual({
      selector: { by: 'text', value: 'OK' },
    })
    expect(targetOf({ id: 'submit' })).toEqual({
      selector: { by: 'id', value: 'submit' },
    })
  })

  it.each([
    [{}, 'Name one target'],
    [{ x: 10 }, 'A point needs both x and y.'],
    [{ x: 10, y: 20, text: 'OK' }, 'Name one target'],
    [{ text: 'OK', label: 'OK' }, 'Name one target'],
  ])('refuses %j', (input, message) => {
    expect(() => targetOf(input)).toThrow(message)
  })
})

describe('findElement', () => {
  const tree = [
    node(
      { type: 'android.widget.FrameLayout', frame: { x: 0, y: 0, ...SCREEN } },
      [
        node({
          text: 'Network & internet',
          id: 'android:id/title',
          frame: { x: 20, y: 100, width: 200, height: 40 },
        }),
        node({
          text: 'Connected devices',
          id: 'android:id/title',
          frame: { x: 20, y: 200, width: 200, height: 40 },
        }),
        node({
          label: 'Search settings',
          id: 'submitButton',
          frame: { x: 300, y: 20, width: 80, height: 40 },
        }),
        node({
          text: 'Below',
          frame: { x: 20, y: 900, width: 200, height: 40 },
        }),
        node({
          text: 'Half',
          frame: { x: 20, y: 780, width: 200, height: 40 },
        }),
      ],
    ),
  ]

  it('finds the element by its whole text, and aims at its centre', () => {
    expect(
      findElement(tree, { by: 'text', value: 'Network & internet' }, SCREEN),
    ).toEqual({
      element: {
        type: 'android.widget.TextView',
        text: 'Network & internet',
        id: 'android:id/title',
        frame: { x: 20, y: 100, width: 200, height: 40 },
      },
      point: { x: 120, y: 120 },
    })
  })

  it('finds by label, and by an id with or without its package', () => {
    expect(
      findElement(tree, { by: 'label', value: 'Search settings' }, SCREEN)
        .point,
    ).toEqual({ x: 340, y: 40 })
    expect(
      findElement(tree, { by: 'id', value: 'submitButton' }, SCREEN).element
        .label,
    ).toBe('Search settings')
  })

  it('aims at the centre of the part on the screen', () => {
    expect(
      findElement(tree, { by: 'text', value: 'Half' }, SCREEN).point,
    ).toEqual({ x: 120, y: 790 })
  })

  it('names close texts when none matches', () => {
    expect(() =>
      findElement(tree, { by: 'text', value: 'network' }, SCREEN),
    ).toThrow(
      'No element on the screen has the text "network". Close ones: "Network & internet".',
    )
  })

  it('says when the element is off the screen', () => {
    expect(() =>
      findElement(tree, { by: 'text', value: 'Below' }, SCREEN),
    ).toThrow(
      'The element with the text "Below" is in the tree, but not on the screen. Scroll it into view first.',
    )
  })

  it('lists the elements when more than one matches', () => {
    expect(() =>
      findElement(tree, { by: 'id', value: 'title' }, SCREEN),
    ).toThrow(
      '2 elements on the screen have the id "title": android.widget.TextView at (20, 100) 200 × 40; android.widget.TextView at (20, 200) 200 × 40. Touch one by its point, or by another selector.',
    )
  })

  it("ends the list with the caller's hint", () => {
    expect(() =>
      findElement(
        tree,
        { by: 'id', value: 'title' },
        SCREEN,
        'Measure one by another selector.',
      ),
    ).toThrow(/× 40\. Measure one by another selector\.$/)
  })

  it.each([
    ['Nothing', 'element_not_found'],
    ['Below', 'element_not_found'],
  ])('gives %s the code %s', (value, code) => {
    expect(
      errorOf(() => findElement(tree, { by: 'text', value }, SCREEN)),
    ).toMatchObject({ code })
  })

  it('gives element_ambiguous for more than one match', () => {
    expect(
      errorOf(() => findElement(tree, { by: 'id', value: 'title' }, SCREEN)),
    ).toMatchObject({ code: 'element_ambiguous' })
  })
})

describe('describeElement', () => {
  it('uses the text, then the label, then the id, then the type', () => {
    const frame = { x: 0, y: 0, width: 1, height: 1 }
    expect(describeElement({ type: 'a.B', text: 'OK', frame })).toBe('"OK"')
    expect(describeElement({ type: 'a.B', label: 'Close', frame })).toBe(
      'label "Close"',
    )
    expect(describeElement({ type: 'a.B', id: 'x', frame })).toBe('#x')
    expect(describeElement({ type: 'a.B', frame })).toBe('B')
  })
})
