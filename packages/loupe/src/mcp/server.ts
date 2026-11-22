import { existsSync } from 'node:fs'
import path from 'node:path'
import { type Readable, type Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import {
  McpServer,
  ProtocolError,
  ProtocolErrorCode,
} from '@modelcontextprotocol/server'
import { type SkillsExtension } from '@modelcontextprotocol/server/ext/skills'
import { loadSkills } from '@modelcontextprotocol/server/ext/skills/node'
import {
  serveStdio,
  StdioServerTransport,
} from '@modelcontextprotocol/server/stdio'
import { registry as defaultRegistry } from '../commands'
import { type Registry } from '../core/command'
import {
  type CommandContext,
  createContext,
  type ProgressUpdate,
} from '../core/context'
import { runCommand } from '../core/run-command'
import { version } from '../version'
import { imageBlocks, toolResult, toolsOf } from './tools'

/** What each MCP client shows its agent about loupe. The skill has the rest. */
export const INSTRUCTIONS = [
  'loupe checks the layout of a mobile app on an Android emulator or device. Its tools give numbers in dp.',
  'Ask the user before you start an emulator, and before you open an app or a link on a device.',
  'On a real phone, give `app` in each call.',
  'Put back the orientation and the theme that you change; a sweep does it itself.',
  'Decide pass or fail with `check` or `sweep`, not from a screenshot alone.',
  'The loupe skill (skills/loupe/SKILL.md in the package) has the workflow, the rules, and what to do for each error code.',
].join(' ')

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
 * The `skills` folder of the package. The search goes up to the folder
 * with `package.json`, because the code runs from `src` in tests and from
 * `dist` in the package.
 */
export function skillsFolder(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url))
  for (;;) {
    if (existsSync(path.join(dir, 'package.json'))) {
      return path.join(dir, 'skills')
    }
    const up = path.dirname(dir)
    if (up === dir) throw new Error("loupe can't find its package folder.")
    dir = up
  }
}

export interface McpServerOptions {
  /** One for each process: calls of all servers run one at a time. */
  oneAtATime?: Serial
  /** The skills that the server serves through the skills extension. */
  skills?: SkillsExtension
}

/**
 * An MCP server with each command of the registry as a tool. Calls run one
 * at a time: two touches at the same time on one device lose events.
 */
export function createMcpServer(
  registry: Registry,
  context: CommandContext,
  { oneAtATime = serial(), skills }: McpServerOptions = {},
): McpServer {
  const tools = toolsOf(registry)
  const byName = new Map(tools.map((tool) => [tool.name, tool]))
  // With no `tools` capability in its options, `McpServer` leaves the tool
  // methods to loupe: `runCommand` stays the one check of each call.
  const mcp = new McpServer(
    { name: 'loupe', version },
    { instructions: INSTRUCTIONS },
  )
  const { server } = mcp
  server.registerCapabilities({ tools: {} })

  server.setRequestHandler('tools/list', () => ({ tools }))
  server.setRequestHandler('tools/call', async (request, ctx) => {
    const { name, arguments: input = {} } = request.params
    const tool = byName.get(name)
    if (!tool) {
      throw new ProtocolError(
        ProtocolErrorCode.InvalidParams,
        `"${name}" is not a loupe tool.`,
      )
    }
    const token = ctx.mcpReq._meta?.progressToken
    const call: CommandContext = {
      ...context,
      signal: ctx.mcpReq.signal,
      ...(token !== undefined && {
        progress: (update: ProgressUpdate) => {
          ctx.mcpReq
            .notify({
              method: 'notifications/progress',
              params: { progressToken: token, ...update },
            })
            // A lost progress note must not fail the call.
            .catch(() => undefined)
        },
      }),
    }
    // The images are read in the queue too: the next call can write a new
    // screenshot to the same file.
    const output = await oneAtATime(async () => {
      const result = await runCommand(registry, name, input, call)
      const shown = toolResult(result)
      const images = result.ok && registry.get(name)?.images?.(result.data)
      if (images) shown.content.push(...(await imageBlocks(images)))
      return shown
    })
    return server.projectCallToolResult(output, tool.outputSchema)
  })

  skills?.attach(mcp)
  return mcp
}

export interface ServeOptions {
  registry?: Registry
  context?: CommandContext
  stdin?: Readable
  stdout?: Writable
  onerror?: (error: Error) => void
}

/**
 * Serves the tools and the skill over stdin and stdout, in each protocol
 * version that the SDK speaks. It ends when the client closes stdin.
 */
export async function serveMcp(options: ServeOptions = {}): Promise<void> {
  const {
    registry = defaultRegistry,
    context = createContext(),
    stdin = process.stdin,
    stdout = process.stdout,
    onerror,
  } = options
  const oneAtATime = serial()
  // A client can close stdin before the SDK makes a server, and then no
  // server closes.
  const ended = new Promise<void>((resolve) => stdin.once('end', resolve))

  const skills = await loadSkills(skillsFolder(), {
    onWarning: ({ path: file, message }) =>
      onerror?.(new Error(`The skill at ${file}: ${message}`)),
  }).catch((error: unknown) => {
    onerror?.(
      new Error(
        `loupe serves no skill: ${error instanceof Error ? error.message : String(error)}`,
      ),
    )
    return undefined
  })

  const closed = new Promise<void>((resolve) => {
    serveStdio(
      () => {
        const mcp = createMcpServer(registry, context, { oneAtATime, skills })
        mcp.server.onclose = resolve
        return mcp
      },
      { transport: new StdioServerTransport(stdin, stdout), onerror },
    )
  })
  await Promise.race([ended, closed])
}
