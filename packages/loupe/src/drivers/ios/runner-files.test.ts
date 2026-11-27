import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { packageFolder } from '../../core/package-folder'
import { findRunner } from './runner-files'

const root = mkdtempSync(path.join(tmpdir(), 'loupe-runner-files-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('findRunner', () => {
  it('gives the .xctestrun file of the runner in the package', () => {
    const dir = path.join(root, 'with', 'dist', 'ios-runner')
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'LoupeRunner.xctestrun'), '')

    expect(findRunner(path.join(root, 'with'))).toBe(
      path.join(dir, 'LoupeRunner.xctestrun'),
    )
  })

  it('fails with tool_missing in a copy with no runner, and names npm', () => {
    const empty = path.join(root, 'empty')
    const file = path.join(empty, 'dist', 'ios-runner', 'LoupeRunner.xctestrun')

    expect(() => findRunner(empty)).toThrow(
      expect.objectContaining({
        code: 'tool_missing',
        message: `This copy of loupe has no runner for the iOS simulator: ${file} isn't there. Install @rootnative/loupe from npm, which has it. A build from the source has none.`,
      }),
    )
  })
})

describe('packageFolder', () => {
  it('finds the folder with package.json above a folder in it', () => {
    const inner = path.join(root, 'pkg', 'dist', 'deep')
    mkdirSync(inner, { recursive: true })
    writeFileSync(path.join(root, 'pkg', 'package.json'), '{}')

    expect(packageFolder(inner)).toBe(path.join(root, 'pkg'))
  })

  it('finds the package of loupe from the source', () => {
    expect(path.basename(packageFolder())).toBe('loupe')
  })
})
