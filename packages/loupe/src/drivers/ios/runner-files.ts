import { existsSync } from 'node:fs'
import path from 'node:path'
import { LoupeError } from '../../core/errors'
import { packageFolder } from '../../core/package-folder'

const RUNNER_DIR = path.join('dist', 'ios-runner')
const XCTESTRUN = 'LoupeRunner.xctestrun'

/**
 * The `.xctestrun` file of the XCTest runner for the iOS simulator, which
 * `xcodebuild test-without-building` takes. The package on npm has the
 * runner in `dist/ios-runner`. A build from the source has none: only CI
 * builds it, because the build needs Xcode. Then it fails with
 * `tool_missing`.
 */
export function findRunner(root = packageFolder()): string {
  const file = path.join(root, RUNNER_DIR, XCTESTRUN)
  if (!existsSync(file)) {
    throw new LoupeError(
      'tool_missing',
      `This copy of loupe has no runner for the iOS simulator: ${file} isn't there. Install @rootnative/loupe from npm, which has it. A build from the source has none.`,
    )
  }
  return file
}
