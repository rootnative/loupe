import { type Exec, nodeExec } from './exec'

/**
 * Everything a command takes from the machine it runs on. A test passes a
 * fake context that replays recorded tool output.
 */
export interface CommandContext {
  exec: Exec
  env: Readonly<Record<string, string | undefined>>
}

/** The real context: child processes, and the environment of this process. */
export function createContext(): CommandContext {
  return { exec: nodeExec, env: process.env }
}
