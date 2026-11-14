import path from 'node:path'
import { type CommandContext } from '../../core/context'
import { LoupeError } from '../../core/errors'
import { type ExecOptions, type ExecResult } from '../../core/exec'

const MESSAGE_LIMIT = 500

export interface Adb {
  /** Runs adb and returns its stdout as raw bytes, for example a PNG. */
  run(args: readonly string[], options?: ExecOptions): Promise<Buffer>
  /** Runs adb and returns its stdout as text. */
  text(args: readonly string[], options?: ExecOptions): Promise<string>
}

/**
 * Where loupe looks for adb, in order: the SDK in `ANDROID_HOME`, the SDK in
 * `ANDROID_SDK_ROOT`, then the PATH.
 */
export function adbCandidates(env: CommandContext['env']): string[] {
  const sdks = [env.ANDROID_HOME, env.ANDROID_SDK_ROOT].filter(
    (sdk): sdk is string => Boolean(sdk),
  )
  const files = sdks.map((sdk) => path.join(sdk, 'platform-tools', 'adb'))
  return [...new Set([...files, 'adb'])]
}

function missingAdb(candidates: readonly string[]): LoupeError {
  const sdkFiles = candidates.filter((file) => file !== 'adb')
  const where =
    sdkFiles.length > 0
      ? `It looked for ${sdkFiles.join(' and ')}, and on the PATH.`
      : 'It looked on the PATH.'
  return new LoupeError(
    'tool_missing',
    `loupe can't find adb. ${where} Install the Android SDK Platform-Tools, or set ANDROID_HOME to the folder of your Android SDK.`,
  )
}

function describeFailure(result: ExecResult): string {
  const status =
    result.code === null
      ? 'adb stopped on a signal'
      : `adb exited with code ${result.code}`
  const output = (result.stderr.length > 0 ? result.stderr : result.stdout)
    .toString('utf8')
    .trim()
  if (!output) return `${status}.`
  return output.length > MESSAGE_LIMIT
    ? `${status}: ${output.slice(0, MESSAGE_LIMIT)}…`
    : `${status}: ${output}`
}

/**
 * Runs adb through the context. It finds adb on the first call and keeps
 * that path. A non-zero exit code fails with `tool_failed` and the output of
 * adb. The message never holds the arguments, because the arguments of the
 * `type` command hold the text it types.
 */
export function createAdb({ exec, env }: CommandContext): Adb {
  let found: string | undefined

  async function execAdb(
    args: readonly string[],
    options?: ExecOptions,
  ): Promise<ExecResult> {
    if (found) return exec(found, args, options)

    const candidates = adbCandidates(env)
    for (const file of candidates) {
      try {
        const result = await exec(file, args, options)
        found = file
        return result
      } catch (error) {
        if (error instanceof LoupeError && error.code === 'tool_missing') {
          continue
        }
        throw error
      }
    }
    throw missingAdb(candidates)
  }

  async function run(
    args: readonly string[],
    options?: ExecOptions,
  ): Promise<Buffer> {
    const result = await execAdb(args, options)
    if (result.code !== 0) {
      throw new LoupeError('tool_failed', describeFailure(result))
    }
    return result.stdout
  }

  return {
    run,
    text: async (args, options) => (await run(args, options)).toString('utf8'),
  }
}
