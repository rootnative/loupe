import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { type CommandContext } from '../../core/context'
import { LoupeError, throwIfCancelled } from '../../core/errors'
import { version } from '../../version'
import { type IosTarget } from '../select'
import { connectRunner, type RunnerClient } from './runner-client'
import { findRunner } from './runner-files'

/** A runner with no request for this long stops by itself. */
export const IDLE_SECONDS = 600

/** The first start of a runner after a boot can take 3 minutes and more. */
const START_TIMEOUT_MS = 300_000
const POLL_MS = 500

/** What a later call needs to find the runner of one simulator again. */
interface RunnerRecord {
  udid: string
  port: number
  token: string
  pid: number
  /** The loupe that started it: another version starts its own runner. */
  version: string
}

export interface RunnerOptions {
  /** Milliseconds to wait for a new runner to answer. Default: 300 000. */
  startTimeout?: number
  /** Milliseconds between two tries to connect. Default: 500. */
  poll?: number
  /** The folder of the package with the runner, for tests. */
  root?: string
}

/**
 * Where loupe keeps the record and the log of each runner. The record has
 * the token, so only the user can read the folder and the file.
 */
export function stateFolder({ env }: CommandContext): string {
  return (
    env.LOUPE_STATE_DIR ??
    path.join(env.HOME ?? homedir(), 'Library', 'Caches', 'loupe')
  )
}

function readRecord(file: string): RunnerRecord | undefined {
  try {
    const record = JSON.parse(readFileSync(file, 'utf8')) as RunnerRecord
    return typeof record.port === 'number' && typeof record.token === 'string'
      ? record
      : undefined
  } catch {
    return undefined
  }
}

/** A port that no process listens on now. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

async function answers(client: RunnerClient): Promise<boolean> {
  try {
    await client.request({ cmd: 'ping' }, { timeout: 5000 })
    return true
  } catch {
    return false
  }
}

/** The runner of the record, when it still answers to its token. */
async function running(
  record: RunnerRecord | undefined,
): Promise<RunnerClient | undefined> {
  if (!record) return undefined
  const client = await connectRunner(record.port, { token: record.token })
  if (!client) return undefined
  if (record.version === version && (await answers(client))) return client
  // A runner of another loupe: it stops, and this loupe starts its own.
  await client.request({ cmd: 'quit' }, { timeout: 5000 }).catch(() => {})
  client.close()
  return undefined
}

async function start(
  context: CommandContext,
  target: IosTarget,
  folder: string,
  recordFile: string,
  { startTimeout = START_TIMEOUT_MS, poll = POLL_MS, root }: RunnerOptions,
): Promise<RunnerClient> {
  const xctestrun = findRunner(root)
  const port = await freePort()
  const token = randomBytes(16).toString('hex')
  const logFile = path.join(folder, `runner-${target.udid}.log`)
  // xcodebuild writes a result bundle there at each start.
  const derived = path.join(folder, `derived-${target.udid}`)
  mkdirSync(folder, { recursive: true, mode: 0o700 })
  rmSync(derived, { recursive: true, force: true })

  let run
  try {
    run = await context.spawnDetached(
      'xcodebuild',
      [
        'test-without-building',
        '-xctestrun',
        xctestrun,
        '-destination',
        `id=${target.udid}`,
        '-derivedDataPath',
        derived,
      ],
      {
        // xcodebuild gives a TEST_RUNNER_<name> variable to the test as <name>.
        env: {
          TEST_RUNNER_LOUPE_PORT: String(port),
          TEST_RUNNER_LOUPE_TOKEN: token,
          TEST_RUNNER_LOUPE_IDLE_SECONDS: String(IDLE_SECONDS),
        },
        logFile,
      },
    )
  } catch (error) {
    if (error instanceof LoupeError && error.code === 'tool_missing') {
      throw new LoupeError(
        'tool_missing',
        "loupe can't find xcodebuild. Install Xcode, then try again.",
        { cause: error },
      )
    }
    throw error
  }

  const started = Date.now()
  while (Date.now() - started < startTimeout) {
    try {
      throwIfCancelled(context.signal)
    } catch (error) {
      run.kill()
      throw error
    }
    const exit = run.exitCode()
    if (exit !== undefined) {
      throw new LoupeError(
        'tool_failed',
        `xcodebuild ended with ${exit ?? 'a signal'} before the iOS runner answered on ${target.name}. Its log is ${logFile}.`,
      )
    }
    const client = await connectRunner(port, { token, timeout: poll })
    if (client) {
      if (await answers(client)) {
        const record: RunnerRecord = {
          udid: target.udid,
          port,
          token,
          pid: run.pid,
          version,
        }
        writeFileSync(recordFile, `${JSON.stringify(record)}\n`, {
          mode: 0o600,
        })
        return client
      }
      client.close()
    }
    await sleep(poll)
  }
  run.kill()
  throw new LoupeError(
    'timeout',
    `The iOS runner didn't answer on ${target.name} in ${Math.round(startTimeout / 1000)} s, so loupe stopped it. Its log is ${logFile}.`,
  )
}

/**
 * A connection to the XCTest runner of the simulator. The first call for a
 * simulator starts the runner with `xcodebuild test-without-building`,
 * which takes from 10 seconds to 3 minutes, and keeps a record of it. The
 * runner stays after the command, and each later call connects to it
 * through the record. It stops by itself after `IDLE_SECONDS` with no
 * request, and when the simulator stops. Close the client after the
 * command; the runner stays.
 */
export async function ensureRunner(
  context: CommandContext,
  target: IosTarget,
  options: RunnerOptions = {},
): Promise<RunnerClient> {
  const folder = stateFolder(context)
  const recordFile = path.join(folder, `runner-${target.udid}.json`)
  return (
    (await running(readRecord(recordFile))) ??
    start(context, target, folder, recordFile, options)
  )
}

/** Stops the runner of the simulator, when one runs, and removes its record. */
export async function stopRunner(
  context: CommandContext,
  target: IosTarget,
): Promise<boolean> {
  const recordFile = path.join(
    stateFolder(context),
    `runner-${target.udid}.json`,
  )
  const record = readRecord(recordFile)
  rmSync(recordFile, { force: true })
  if (!record) return false
  const client = await connectRunner(record.port, { token: record.token })
  if (!client) return false
  await client.request({ cmd: 'quit' }, { timeout: 5000 }).catch(() => {})
  client.close()
  return true
}
