import { describe, expect, it } from 'vitest'
import { parseXml } from './xml'

describe('parseXml', () => {
  it('reads nested and self-closing elements with their attributes', () => {
    const text = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="1"><node index="0" text=""><node index="0" text="a" /><node index='1' text = "b"/></node></hierarchy>`

    expect(parseXml(text)).toEqual({
      name: 'hierarchy',
      attributes: { rotation: '1' },
      children: [
        {
          name: 'node',
          attributes: { index: '0', text: '' },
          children: [
            {
              name: 'node',
              attributes: { index: '0', text: 'a' },
              children: [],
            },
            {
              name: 'node',
              attributes: { index: '1', text: 'b' },
              children: [],
            },
          ],
        },
      ],
    })
  })

  it('skips text after the root, and comments', () => {
    expect(
      parseXml('<!-- a > b --><hierarchy />UI hierchary dumped to: /dev/tty\n'),
    ).toEqual({ name: 'hierarchy', attributes: {}, children: [] })
  })

  it.each([
    ['&amp; &lt; &gt; &quot; &apos;', `& < > " '`],
    ['line&#10;line', 'line\nline'],
    ['&#x41;&#66;', 'AB'],
    ['&#55357;&#56832;', '😀'],
    ['&#128512;', '😀'],
    ['a > b', 'a > b'],
    ['&unknown; &#99999999;', '&unknown; &#99999999;'],
  ])('decodes %s', (raw, value) => {
    expect(parseXml(`<node text="${raw}" />`).attributes.text).toBe(value)
  })

  it.each([
    ['<a><b></a>', "</a> doesn't close the open element."],
    ['<a>', "<a> isn't closed."],
    ['<a /><b />', '<b> is a second root element.'],
    ['ERROR: could not get idle state.', 'The text has no element.'],
  ])('refuses %s', (text, message) => {
    expect(() => parseXml(text)).toThrow(message)
  })
})
