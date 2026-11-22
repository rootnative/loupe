import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { registry } from './commands'
import { RULES } from './core/check'

// Git on Windows checks out text files with CRLF line ends.
const text = (
  await readFile(new URL('../README.md', import.meta.url), 'utf8')
).replace(/\r\n/g, '\n')

describe('the README of the package', () => {
  it.each(registry.list().map((command) => command.name))(
    'lists the command %s',
    (name) => {
      expect(text).toContain(`| \`${name}\` |`)
    },
  )

  it.each(RULES)('explains the rule %s', (rule) => {
    expect(text).toContain(`| \`${rule}\` |`)
  })
})
