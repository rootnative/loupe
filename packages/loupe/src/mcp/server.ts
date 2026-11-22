import { type Readable, type Writable } from 'node:stream'
import {
  ProtocolError,
  ProtocolErrorCode,
  Server,
} from '@modelcontextprotocol/server'
import {
  serveStdio,
  StdioServerTransport,
} from '@modelcontextprotocol/server/stdio'
import { registry as defaultRegistry } from '../commands'
import { type Registry } from '../core/command'
import { type CommandContext, createContext } from '../core/context'
import { type CommandResult, runCommand } from '../core/run-command'
import { version } from '../version'
import { toolResult, toolsOf } from './tools'

/** Runs each task after the one before it ends. */
export type Serial = <T>(task: () => Promise<T>) => Promise<T>

export function serial(): Serial {
  let last: Promise<unknown> = Promise.resolve()
  return (task) => {
    const next = last.then(task)
    last = next.catch(() => undefined)
    return next
  }
}

/**
 * An MCP server with each command of the registry as a tool. Calls run one
 * at a time: two touches at the same time on one device lose events.
 */
export function createMcpServer(
  registry: Registry,
  context: CommandContext,
  oneAtATime: Serial = serial(),
): Server {
  const tools = toolsOf(registry)
  const byName = new Map(tools.map((tool) => [tool.name, tool]))
  const server = new Server(
    { name: 'loupe', version },
    { capabilities: { tools: {} } },
  )

  server.setRequestHandler('tools/list', () => ({ tools }))
  server.setRequestHandler('tools/call', async (request) => {
    const { name, arguments: input = {} } = request.params
    const tool = byName.get(name)
    if (!tool) {
      throw new ProtocolError(
        ProtocolErrorCode.InvalidParams,
        `"${name}" is not a loupe tool.`,
      )
    }
    const result: CommandResult = await oneAtATime(() =>
      runCommand(registry, name, input, context),
    )
    return server.projectCallToolResult(toolResult(result), tool.outputSchema)
  })

  return server
}

export interface ServeOptions {
  registry?: Registry
  context?: CommandContext
  stdin?: Readable
  stdout?: Writable
  onerror?: (error: Error) => void
}

/**
 * Serves the tools over stdin and stdout, in each protocol version that
 * the SDK speaks. It ends when the client closes stdin.
 */
export function serveMcp(options: ServeOptions = {}): Promise<void> {
  const {
    registry = defaultRegistry,
    context = createContext(),
    stdin = process.stdin,
    stdout = process.stdout,
    onerror,
  } = options
  const oneAtATime = serial()

  return new Promise((resolve) => {
    // A client can close stdin before the SDK makes a server, and then no
    // server closes.
    stdin.once('end', () => resolve())
    serveStdio(
      () => {
        const server = createMcpServer(registry, context, oneAtATime)
        server.onclose = () => resolve()
        return server
      },
      { transport: new StdioServerTransport(stdin, stdout), onerror },
    )
  })
}
