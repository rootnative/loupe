export interface XmlElement {
  name: string
  attributes: Record<string, string>
  children: XmlElement[]
}

// A start tag, an end tag, or a part to skip: the declaration or a comment.
const TOKEN =
  /<(\/?)([A-Za-z_][\w.:-]*)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|<\?[\s\S]*?\?>|<!--[\s\S]*?-->/g
const ATTRIBUTE = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
const ENTITY = /&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g
const NAMED: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
}

function decode(value: string): string {
  return value.replace(ENTITY, (whole, ref: string) => {
    if (!ref.startsWith('#')) return NAMED[ref] ?? whole
    const code =
      ref[1] === 'x'
        ? Number.parseInt(ref.slice(2), 16)
        : Number.parseInt(ref.slice(1), 10)
    // A character above U+FFFF can come as two references, one for each
    // UTF-16 half. fromCharCode keeps each half, so the two join up again.
    if (code <= 0xffff) return String.fromCharCode(code)
    return code <= 0x10ffff ? String.fromCodePoint(code) : whole
  })
}

function attributesOf(source: string): Record<string, string> {
  const attributes: Record<string, string> = {}
  for (const [, name = '', double, single] of source.matchAll(ATTRIBUTE)) {
    attributes[name] = decode(double ?? single ?? '')
  }
  return attributes
}

/**
 * Reads the elements and the attributes of an XML document, as uiautomator
 * writes it. It skips text between tags, comments and the declaration, and
 * throws an error when the tags don't match.
 */
export function parseXml(text: string): XmlElement {
  const open: XmlElement[] = []
  let root: XmlElement | undefined

  for (const [, closing, name, attributes = '', selfClosing] of text.matchAll(
    TOKEN,
  )) {
    if (!name) continue

    if (closing) {
      if (open.pop()?.name !== name) {
        throw new Error(`</${name}> doesn't close the open element.`)
      }
      continue
    }

    const element: XmlElement = {
      name,
      attributes: attributesOf(attributes),
      children: [],
    }
    const parent = open.at(-1)
    if (parent) {
      parent.children.push(element)
    } else if (root) {
      throw new Error(`<${name}> is a second root element.`)
    } else {
      root = element
    }
    if (!selfClosing) open.push(element)
  }

  const unclosed = open.at(-1)
  if (unclosed) throw new Error(`<${unclosed.name}> isn't closed.`)
  if (!root) throw new Error('The text has no element.')
  return root
}
