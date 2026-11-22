import { PassThrough } from 'node:stream'
import { Client } from '@modelcontextprotocol/client'
import { InMemoryTransport, ProtocolError } from '@modelcontextprotocol/server'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import pkg from '../../package.json'
import { registry } from '../commands'
import { createRegistry, defineCommand, type Registry } from '../core/command'
import { type CommandContext } from '../core/context'
import { byCommand, fakeContext, missingTool } from '../testing/fake-exec'
import { createMcpServer, serveMcp } from './server'

const ERAS = [
  { protocol: '2025-11-25', options: {} },
  {
    protocol: '2026-07-28',
    options: { versionNegotiation: { mode: { pin: '2026-07-28' } } } as const,
  },
] as const

const closers: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const close of closers.splice(0)) await close()
})

async function connect(
  era: (typeof ERAS)[number],
  tools: Registry,
  context: CommandContext = fakeContext(() => undefined).context,
): Promise<Client> {
  const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair()
  const handle = serveStdio(() => createMcpServer(tools, context), {
    transport: serverEnd,
  })
  const client = new Client({ name: 'test', version: '0.0.0' }, era.options)
  await client.connect(clientEnd)
  closers.push(async () => {
    await client.close()
    await handle.close()
  })
  return client
}

describe.each(ERAS)('the MCP server, protocol $protocol', (era) => {
  it('speaks that protocol, and names loupe and its version', async () => {
    const client = await connect(era, registry)

    expect(client.getNegotiatedProtocolVersion()).toBe(era.protocol)
    expect(client.getServerVersion()).toMatchObject({
      name: 'loupe',
      version: pkg.version,
    })
  })

  it('lists each command as a tool, with its schemas', async () => {
    const client = await connect(era, registry)

    const { tools } = await client.listTools()

    expect(tools.map((tool) => tool.name)).toEqual(
      registry.list().map((command) => command.name),
    )
    const ui = tools.find((tool) => tool.name === 'ui')
    expect(ui?.outputSchema?.type).toBe('object')
    expect(ui?.annotations?.readOnlyHint).toBe(true)
  })

  it('runs a command, and gives its data as structured content', async () => {
    const { context } = fakeContext(
      byCommand({
        'adb devices -l': { stdout: 'List of devices attached\n\n' },
        'emulator -list-avds': { stdout: 'Small_API_30\n' },
      }),
    )
    const client = await connect(era, registry, context)

    const result = await client.callTool({ name: 'devices', arguments: {} })

    expect(result.isError).toBeFalsy()
    expect(result.structuredContent).toMatchObject({
      devices: [{ kind: 'emulator', avd: 'Small_API_30', state: 'stopped' }],
    })
  })

  it('gives a command that fails as a tool error with its code', async () => {
    const { context } = fakeContext(
      byCommand({ 'adb devices -l': missingTool('adb') }),
    )
    const client = await connect(era, registry, context)

    const result = await client.callTool({ name: 'ui', arguments: {} })

    expect(result.isError).toBe(true)
    expect(result.content).toEqual([
      {
        type: 'text',
        text: expect.stringContaining('"code":"tool_missing"'),
      },
    ])
  })

  it('gives wrong arguments as a tool error, so the agent can fix them', async () => {
    const client = await connect(era, registry)

    const result = await client.callTool({
      name: 'rotate',
      arguments: { to: 'sideways' },
    })

    expect(result.isError).toBe(true)
    expect(result.content).toEqual([
      {
        type: 'text',
        text: expect.stringContaining('"code":"invalid_input"'),
      },
    ])
  })

  it('refuses a tool that loupe has not', async () => {
    const client = await connect(era, registry)

    const call = client.callTool({ name: 'teleport', arguments: {} })

    await expect(call).rejects.toBeInstanceOf(ProtocolError)
    await expect(call).rejects.toMatchObject({ code: -32602 })
  })
})

describe('the MCP server, calls at the same time', () => {
  it('runs one call after the other', async () => {
    const events: string[] = []
    const step = defineCommand({
      name: 'step',
      summary: 'Takes a step',
      input: z.object({ id: z.string(), ms: z.number() }),
      output: z.object({ id: z.string() }),
      run: async ({ id, ms }) => {
        events.push(`start ${id}`)
        await new Promise((resolve) => setTimeout(resolve, ms))
        events.push(`end ${id}`)
        return { id }
      },
    })
    const client = await connect(ERAS[0], createRegistry([step]))

    await Promise.all([
      client.callTool({ name: 'step', arguments: { id: 'a', ms: 40 } }),
      client.callTool({ name: 'step', arguments: { id: 'b', ms: 0 } }),
    ])

    expect(events).toEqual(['start a', 'end a', 'start b', 'end b'])
  })
})

describe('serveMcp', () => {
  function lines(stream: PassThrough): () => Promise<unknown> {
    let buffer = ''
    const waiting: ((line: string) => void)[] = []
    const ready: string[] = []
    stream.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      let end
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end)
        buffer = buffer.slice(end + 1)
        const next = waiting.shift()
        if (next) next(line)
        else ready.push(line)
      }
    })
    return () =>
      new Promise((resolve) => {
        const line = ready.shift()
        if (line !== undefined) resolve(JSON.parse(line))
        else waiting.push((text) => resolve(JSON.parse(text)))
      })
  }

  function send(stdin: PassThrough, message: object): void {
    stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
  }

  it('answers JSON-RPC lines on stdout, and ends when stdin closes', async () => {
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    const next = lines(stdout)
    const served = serveMcp({ stdin, stdout })

    send(stdin, {
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'test', version: '0.0.0' },
      },
    })
    expect(await next()).toMatchObject({
      id: 1,
      result: {
        protocolVersion: '2025-11-25',
        serverInfo: { name: 'loupe', version: pkg.version },
        capabilities: { tools: {} },
      },
    })

    send(stdin, { method: 'notifications/initialized' })
    send(stdin, { id: 2, method: 'tools/list' })
    const listed = (await next()) as { result: { tools: unknown[] } }
    expect(listed.result.tools).toHaveLength(registry.list().length)

    stdin.end()
    await expect(served).resolves.toBeUndefined()
  })

  it('ends when stdin closes before any message', async () => {
    const stdin = new PassThrough()
    const served = serveMcp({ stdin, stdout: new PassThrough() })

    stdin.end()

    await expect(served).resolves.toBeUndefined()
  })
})
