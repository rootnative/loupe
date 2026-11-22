import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { RULES } from '../core/check'
import { ERROR_CODES } from '../core/errors'
import { skillsFolder } from './server'

/** Codes that only a wrong CLI command or a loupe bug gives. */
const NOT_FOR_AGENTS = new Set([
  'unknown_command',
  'invalid_output',
  'internal',
])

const text = await readFile(
  path.join(skillsFolder(), 'loupe', 'SKILL.md'),
  'utf8',
)

describe('the loupe skill', () => {
  it('has a name that matches its folder, and a description', () => {
    const [, frontmatter] = /^---\n([\s\S]*?)\n---\n/.exec(text) ?? []

    expect(frontmatter).toMatch(/^name: loupe$/m)
    expect(frontmatter).toMatch(/^description: .{40,1024}$/m)
  })

  it.each(RULES)('explains the rule %s', (rule) => {
    expect(text).toContain(`| \`${rule}\` |`)
  })

  it.each(ERROR_CODES.filter((code) => !NOT_FOR_AGENTS.has(code)))(
    'says what to do for the code %s',
    (code) => {
      expect(text).toContain(`| \`${code}\` |`)
    },
  )
})
