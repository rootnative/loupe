import { spawn } from 'node:child_process'
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
