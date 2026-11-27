import { type CommandContext } from '../../core/context'
import { LoupeError } from '../../core/errors'
import { describeToolFailure, type ExecOptions } from '../../core/exec'

export interface Simctl {
  /** Runs `xcrun simctl` and returns its stdout as text. */
  text(args: readonly string[], options?: ExecOptions): Promise<string>
}

/**
 * Runs `simctl` of the Xcode in use, through `xcrun` and the context. A
 * non-zero exit code fails with `tool_failed` and the output of the tool:
 * `xcrun` gives one when the Mac has no Xcode. The message never holds the
 * arguments.
 */
export function createSimctl({ exec }: CommandContext): Simctl {
  return {
    text: async (args, options) => {
      let result
      try {
        result = await exec('xcrun', ['simctl', ...args], options)
      } catch (error) {
        if (error instanceof LoupeError && error.code === 'tool_missing') {
          throw new LoupeError(
            'tool_missing',
            "loupe can't find xcrun. Install Xcode, then try again.",
            { cause: error },
          )
        }
        throw error
      }
      if (result.code !== 0) {
        throw new LoupeError(
          'tool_failed',
          describeToolFailure('simctl', result),
        )
      }
      return result.stdout.toString('utf8')
    },
  }
}
