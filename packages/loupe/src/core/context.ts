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
   * Aborts when the caller cancels the call: Ctrl-C in the CLI, or a
   * cancel from the MCP client. A long command stops at its next safe
   * point; a tool that runs isn't stopped.
   */
  signal?: AbortSignal
  /** Takes the progress of a long command, for the caller to show. */
  progress?: (update: ProgressUpdate) => void
}

/** The real context: child processes, and the environment of this process. */
export function createContext(): CommandContext {
  return { exec: nodeExec, env: process.env }
}
