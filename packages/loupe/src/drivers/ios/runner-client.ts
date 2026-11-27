import { connect, type Socket } from 'node:net'
import { LoupeError } from '../../core/errors'
import { DEFAULT_TIMEOUT_MS } from '../../core/exec'

/** One request to the runner: a command and its fields. */
export interface RunnerRequest {
  cmd: string
  [field: string]: unknown
}

/** What the runner gave for a request that worked, with its time in ms. */
export type RunnerAnswer = Record<string, unknown>

export interface RunnerClient {
  /**
   * Sends one request and gives its answer. It fails with `tool_failed`
   * when the runner couldn't do it or closed the connection, and with
   * `timeout` when no answer comes in time. One request at a time.
   */
  request(
    message: RunnerRequest,
    options?: { timeout?: number },
  ): Promise<RunnerAnswer>
  close(): void
}

const CONNECT_TIMEOUT_MS = 2000

export interface ConnectOptions {
  /** Goes into each request: a runner with a token takes no other. */
  token?: string
  /** Milliseconds to wait for the connection. Default: 2000. */
  timeout?: number
}

const seconds = (ms: number): string =>
  ms >= 1000 && ms % 1000 === 0 ? `${ms / 1000} s` : `${ms} ms`

/**
 * Connects to the XCTest runner on 127.0.0.1:`port`, never on another
 * address. Gives undefined when nothing listens there, so the caller can
 * start the runner. The runner takes one JSON object per line and gives
 * one per line, with the `id` of its request.
 */
export function connectRunner(
  port: number,
  { token, timeout = CONNECT_TIMEOUT_MS }: ConnectOptions = {},
): Promise<RunnerClient | undefined> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port })
    const timer = setTimeout(() => {
      socket.destroy()
      resolve(undefined)
    }, timeout)
    socket.once('connect', () => {
      clearTimeout(timer)
      resolve(clientOf(socket, token))
    })
    socket.once('error', () => {
      clearTimeout(timer)
      resolve(undefined)
    })
  })
}

interface Waiting {
  id: number
  cmd: string
  resolve: (answer: RunnerAnswer) => void
  reject: (error: LoupeError) => void
}

function failure(cmd: string, answer: Record<string, unknown>): LoupeError {
  const reason =
    typeof answer.error === 'string' ? answer.error : 'It gave no reason.'
  return new LoupeError(
    'tool_failed',
    `The iOS runner couldn't do "${cmd}": ${reason}`,
  )
}

function clientOf(socket: Socket, token?: string): RunnerClient {
  let buffer = ''
  let waiting: Waiting | undefined
  let nextId = 1

  const settle = (): Waiting | undefined => {
    const current = waiting
    waiting = undefined
    return current
  }
  const fail = (text: string): void => {
    settle()?.reject(new LoupeError('tool_failed', text))
  }

  socket.setEncoding('utf8')
  socket.on('data', (chunk: string) => {
    buffer += chunk
    for (let end; (end = buffer.indexOf('\n')) >= 0;) {
      const line = buffer.slice(0, end)
      buffer = buffer.slice(end + 1)
      let answer: Record<string, unknown>
      try {
        answer = JSON.parse(line) as Record<string, unknown>
      } catch {
        fail("The iOS runner gave an answer that isn't JSON.")
        continue
      }
      // An answer to a request that already ran out of time.
      if (!waiting || answer.id !== waiting.id) continue
      const current = settle()
      if (answer.ok === true) current?.resolve(answer)
      else current?.reject(failure(current.cmd, answer))
    }
  })
  socket.on('error', () => fail('The connection to the iOS runner failed.'))
  socket.on('close', () => fail('The iOS runner closed the connection.'))

  return {
    request(message, { timeout = DEFAULT_TIMEOUT_MS } = {}) {
      if (waiting) {
        throw new LoupeError(
          'internal',
          'The iOS runner takes one request at a time.',
        )
      }
      return new Promise<RunnerAnswer>((resolve, reject) => {
        const id = nextId++
        const timer = setTimeout(() => {
          // The connection ends here, so a late answer can't go to the
          // next request.
          waiting = undefined
          socket.destroy()
          reject(
            new LoupeError(
              'timeout',
              `The iOS runner gave no answer to "${message.cmd}" in ${seconds(timeout)}.`,
            ),
          )
        }, timeout)
        waiting = {
          id,
          cmd: message.cmd,
          resolve: (answer) => {
            clearTimeout(timer)
            resolve(answer)
          },
          reject: (error) => {
            clearTimeout(timer)
            reject(error)
          },
        }
        socket.write(`${JSON.stringify({ ...message, id, token })}\n`)
      })
    },
    close() {
      socket.destroy()
    },
  }
}
