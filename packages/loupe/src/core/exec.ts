import { spawn } from 'node:child_process'
import { closeSync, openSync } from 'node:fs'
import path from 'node:path'
import { LoupeError } from './errors'

export interface ExecOptions {
  /** Milliseconds before loupe stops the tool. Default: 30 000. */
  timeout?: number
}

export interface ExecResult {
  /** The exit code, or `null` when a signal stopped the tool. */
  code: number | null
  /** Raw bytes, because a tool can write binary data, for example a PNG. */
  stdout: Buffer
  stderr: Buffer
}

/**
 * Runs a tool with no shell, so no argument goes through shell parsing. It
 * fails with `tool_missing` when the tool doesn't exist, and with `timeout`
 * when the tool runs too long. A non-zero exit code isn't a failure here:
 * the caller decides what it means.
 */
export type Exec = (
  file: string,
  args: readonly string[],
  options?: ExecOptions,
) => Promise<ExecResult>

export const DEFAULT_TIMEOUT_MS = 30_000

/** A tool that keeps running after the command that started it. */
export interface DetachedRun {
  pid: number
  /** The exit code (null for a signal) when the tool ended; else undefined. */
  exitCode(): number | null | undefined
  kill(): void
}

export interface DetachedOptions {
  /** Added to the environment of this process. */
  env: Readonly<Record<string, string>>
  /** The tool writes its output here. An old file is replaced. */
  logFile: string
}

/**
 * Starts a tool with no shell that lives on when this process ends. It
 * fails with `tool_missing` when the tool doesn't exist.
 */
export type SpawnDetached = (
  file: string,
  args: readonly string[],
  options: DetachedOptions,
) => Promise<DetachedRun>

export const nodeSpawnDetached: SpawnDetached = (file, args, options) =>
  new Promise((resolve, reject) => {
    const log = openSync(options.logFile, 'w')
    const child = spawn(file, args, {
      shell: false,
      detached: true,
      stdio: ['ignore', log, log],
      env: { ...process.env, ...options.env },
      windowsHide: true,
    })
    // The child has its own copy of the file.
    closeSync(log)
    let exit: number | null | undefined
    child.once('exit', (code) => {
      exit = code
    })
    child.once('error', (error: NodeJS.ErrnoException) => {
      reject(
        error.code === 'ENOENT'
          ? new LoupeError('tool_missing', `loupe can't find "${file}".`, {
              cause: error,
            })
          : new LoupeError(
              'tool_failed',
              `loupe can't start "${file}": ${error.message}`,
              { cause: error },
            ),
      )
    })
    child.once('spawn', () => {
      child.unref()
      resolve({
        pid: child.pid ?? 0,
        exitCode: () => exit,
        kill: () => {
          child.kill()
        },
      })
    })
  })

const FAILURE_LIMIT = 500

/**
 * What a tool said when it ended with a non-zero exit code or on a signal:
 * its stderr, or its stdout when it wrote no stderr, cut at 500 characters.
 * The text never holds the arguments.
 */
export function describeToolFailure(name: string, result: ExecResult): string {
  const status =
    result.code === null
      ? `${name} stopped on a signal`
      : `${name} exited with code ${result.code}`
  const output = (result.stderr.length > 0 ? result.stderr : result.stdout)
    .toString('utf8')
    .trim()
  if (!output) return `${status}.`
  return output.length > FAILURE_LIMIT
    ? `${status}: ${output.slice(0, FAILURE_LIMIT)}…`
    : `${status}: ${output}`
}

function toolName(file: string): string {
  return path.parse(file).name || file
}

function formatDuration(ms: number): string {
  return ms >= 1000 && ms % 1000 === 0 ? `${ms / 1000} s` : `${ms} ms`
}

export const nodeExec: Exec = (file, args, options = {}) => {
  const timeout = options.timeout ?? DEFAULT_TIMEOUT_MS

  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let settled = false

    function settle(done: () => void): void {
      if (settled) return
      settled = true
      clearTimeout(timer)
      done()
    }

    // The promise doesn't wait for the stopped tool to close its output, in
    // case a child process of the tool still holds it open.
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      settle(() =>
        reject(
          new LoupeError(
            'timeout',
            `${toolName(file)} didn't finish in ${formatDuration(timeout)}, so loupe stopped it.`,
          ),
        ),
      )
    }, timeout)

    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))

    child.on('error', (error: NodeJS.ErrnoException) => {
      settle(() =>
        reject(
          error.code === 'ENOENT'
            ? new LoupeError('tool_missing', `loupe can't find "${file}".`, {
                cause: error,
              })
            : new LoupeError(
                'tool_failed',
                `loupe can't start "${file}": ${error.message}`,
                { cause: error },
              ),
        ),
      )
    })

    child.on('close', (code) => {
      settle(() =>
        resolve({
          code,
          stdout: Buffer.concat(stdout),
          stderr: Buffer.concat(stderr),
        }),
      )
    })
  })
}
