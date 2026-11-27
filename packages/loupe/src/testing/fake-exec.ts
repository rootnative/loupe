import path from 'node:path'
import { type CommandContext } from '../core/context'
import { LoupeError } from '../core/errors'
import { type Exec, type ExecOptions } from '../core/exec'

export interface FakeCall {
  file: string
  args: string[]
  options?: ExecOptions
}

/** One run of a tool. The fields match the files of the fixture recorder. */
export interface FakeRun {
  stdout?: string | Buffer
  stderr?: string
  /** Default: 0. */
  code?: number | null
}

/**
 * Answers one call. Return `undefined` for a call that the test doesn't
 * expect, and throw a `LoupeError` to fail the call.
 */
export type FakeHandler = (call: FakeCall) => FakeRun | undefined

/**
 * A context whose `exec` answers from a handler and records each call. It
 * says that it runs on Linux, so no command looks for Xcode, unless
 * `hostPlatform` says another system.
 */
export function fakeContext(
  handler: FakeHandler,
  env: CommandContext['env'] = {},
  hostPlatform: NodeJS.Platform = 'linux',
): { context: CommandContext; calls: FakeCall[] } {
  const calls: FakeCall[] = []

  const exec: Exec = async (file, args, options) => {
    const call: FakeCall = { file, args: [...args], options }
    calls.push(call)
    const run = handler(call)
    if (!run) throw new Error(`No fake run for: ${file} ${args.join(' ')}`)
    return {
      code: run.code === undefined ? 0 : run.code,
      stdout: Buffer.from(run.stdout ?? ''),
      stderr: Buffer.from(run.stderr ?? ''),
    }
  }

  return { context: { exec, env, fetch: noFetch, hostPlatform }, calls }
}

/** The `fetch` of a test that makes no HTTP call: each call fails. */
const noFetch: typeof fetch = async (input) => {
  throw new Error(
    `No fake response for: ${input instanceof Request ? input.url : String(input)}`,
  )
}

/**
 * A handler that answers from a table. Each key is the tool name and its
 * arguments, for example `adb -s emulator-5554 shell getprop`. A `LoupeError`
 * in the table fails that call. A list answers the calls in order, and its
 * last item answers each call after that.
 */
export function byCommand(
  runs: Readonly<
    Record<string, FakeRun | LoupeError | readonly (FakeRun | LoupeError)[]>
  >,
): FakeHandler {
  const counts = new Map<string, number>()

  return ({ file, args }) => {
    const key = [path.parse(file).name, ...args].join(' ')
    const entry = runs[key]
    let run: FakeRun | LoupeError | undefined
    if (Array.isArray(entry)) {
      const count = counts.get(key) ?? 0
      counts.set(key, count + 1)
      run = entry[Math.min(count, entry.length - 1)]
    } else {
      run = entry as FakeRun | LoupeError | undefined
    }
    if (run instanceof LoupeError) throw run
    return run
  }
}

/** The error that the real `exec` gives for a tool that doesn't exist. */
export function missingTool(file: string): LoupeError {
  return new LoupeError('tool_missing', `loupe can't find "${file}".`)
}
