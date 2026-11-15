import path from 'node:path'
import { type CommandContext } from '../../core/context'
import { LoupeError } from '../../core/errors'
import { type ExecOptions, type ExecResult } from '../../core/exec'

const MESSAGE_LIMIT = 500

/** A tool of the Android SDK. */
export interface SdkToolInfo {
  /** The file name, for example `adb`. */
  name: string
  /** The folder of the tool in the SDK. */
  dir: string
  /** What to install when loupe can't find the tool. */
  install: string
}

export const ADB: SdkToolInfo = {
  name: 'adb',
  dir: 'platform-tools',
  install: 'the Android SDK Platform-Tools',
}

export const EMULATOR: SdkToolInfo = {
  name: 'emulator',
  dir: 'emulator',
  install: 'the Android Emulator',
}

export interface SdkTool {
  /** Runs the tool and returns its stdout as raw bytes, for example a PNG. */
  run(args: readonly string[], options?: ExecOptions): Promise<Buffer>
  /** Runs the tool and returns its stdout as text. */
  text(args: readonly string[], options?: ExecOptions): Promise<string>
  /**
   * Runs the tool and returns what it gave, with a non-zero exit code too:
   * for a tool whose exit code differs from one Android version to the next.
   */
  result(args: readonly string[], options?: ExecOptions): Promise<ExecResult>
}

/**
 * Where loupe looks for a tool, in order: the SDK in `ANDROID_HOME`, the SDK
 * in `ANDROID_SDK_ROOT`, then the PATH.
 */
export function sdkToolCandidates(
  env: CommandContext['env'],
  tool: SdkToolInfo,
): string[] {
  const sdks = [env.ANDROID_HOME, env.ANDROID_SDK_ROOT].filter(
    (sdk): sdk is string => Boolean(sdk),
  )
  const files = sdks.map((sdk) => path.join(sdk, tool.dir, tool.name))
  return [...new Set([...files, tool.name])]
}

function missingTool(
  tool: SdkToolInfo,
  candidates: readonly string[],
): LoupeError {
  const sdkFiles = candidates.filter((file) => file !== tool.name)
  const where =
    sdkFiles.length > 0
      ? `It looked for ${sdkFiles.join(' and ')}, and on the PATH.`
      : 'It looked on the PATH.'
  return new LoupeError(
    'tool_missing',
    `loupe can't find ${tool.name}. ${where} Install ${tool.install}, or set ANDROID_HOME to the folder of your Android SDK.`,
  )
}

function describeFailure(tool: SdkToolInfo, result: ExecResult): string {
  const status =
    result.code === null
      ? `${tool.name} stopped on a signal`
      : `${tool.name} exited with code ${result.code}`
  const output = (result.stderr.length > 0 ? result.stderr : result.stdout)
    .toString('utf8')
    .trim()
  if (!output) return `${status}.`
  return output.length > MESSAGE_LIMIT
    ? `${status}: ${output.slice(0, MESSAGE_LIMIT)}…`
    : `${status}: ${output}`
}

/**
 * Runs an SDK tool through the context. It finds the tool on the first call
 * and keeps that path. A non-zero exit code fails with `tool_failed` and the
 * output of the tool. The message never holds the arguments, because the
 * arguments of the `type` command hold the text it types.
 */
export function createSdkTool(
  { exec, env }: CommandContext,
  tool: SdkToolInfo,
): SdkTool {
  let found: string | undefined

  async function execTool(
    args: readonly string[],
    options?: ExecOptions,
  ): Promise<ExecResult> {
    if (found) return exec(found, args, options)

    const candidates = sdkToolCandidates(env, tool)
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
    throw missingTool(tool, candidates)
  }

  async function run(
    args: readonly string[],
    options?: ExecOptions,
  ): Promise<Buffer> {
    const result = await execTool(args, options)
    if (result.code !== 0) {
      throw new LoupeError('tool_failed', describeFailure(tool, result))
    }
    return result.stdout
  }

  return {
    run,
    text: async (args, options) => (await run(args, options)).toString('utf8'),
    result: execTool,
  }
}
