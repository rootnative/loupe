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

/** A context whose `exec` answers from a handler and records each call. */
export function fakeContext(
  handler: FakeHandler,
  env: CommandContext['env'] = {},
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

  return { context: { exec, env }, calls }
}

/** The error that the real `exec` gives for a tool that doesn't exist. */
export function missingTool(file: string): LoupeError {
  return new LoupeError('tool_missing', `loupe can't find "${file}".`)
}
