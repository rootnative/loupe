import { LoupeError } from './errors'
import { type Exec, nodeExec } from './exec'

/** How far a long command is. `progress` grows with each update. */
export interface ProgressUpdate {
  progress: number
  total?: number
  message?: string
}

/**
 * Everything a command takes from the machine it runs on. A test passes a
 * fake context that replays recorded tool output.
 */
export interface CommandContext {
  exec: Exec
  env: Readonly<Record<string, string | undefined>>
  /**
   * HTTP to a server on this machine, such as Metro. `createContext` gives
   * `localFetch`, which refuses every other host.
   */
  fetch: typeof fetch
  /**
   * Aborts when the caller cancels the call: Ctrl-C in the CLI, or a
   * cancel from the MCP client. A long command stops at its next safe
   * point; a tool that runs isn't stopped.
   */
  signal?: AbortSignal
  /** Takes the progress of a long command, for the caller to show. */
  progress?: (update: ProgressUpdate) => void
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]'])

/**
 * `fetch` for this machine only: loupe makes no call over the network, and
 * the README says so.
 */
export const localFetch: typeof fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input)
  if (!LOOPBACK.has(url.hostname)) {
    throw new LoupeError(
      'internal',
      `loupe calls only servers on this machine, not ${url.host}.`,
    )
  }
  return fetch(input, init)
}

/**
 * The real context: child processes, the environment of this process, and
 * HTTP to this machine.
 */
export function createContext(): CommandContext {
  return { exec: nodeExec, env: process.env, fetch: localFetch }
}
