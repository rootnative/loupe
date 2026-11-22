import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { Client } from '@modelcontextprotocol/client'
import { SkillsClient } from '@modelcontextprotocol/client/ext/skills'
import { InMemoryTransport, ProtocolError } from '@modelcontextprotocol/server'
import { type SkillsExtension } from '@modelcontextprotocol/server/ext/skills'
import { loadSkills } from '@modelcontextprotocol/server/ext/skills/node'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import pkg from '../../package.json'
import { registry } from '../commands'
import { createRegistry, defineCommand, type Registry } from '../core/command'
import { type CommandContext } from '../core/context'
import { throwIfCancelled } from '../core/errors'
import { byCommand, fakeContext, missingTool } from '../testing/fake-exec'
import { recorded } from '../testing/fixtures'
import { createMcpServer, INSTRUCTIONS, serveMcp, skillsFolder } from './server'

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
  skills?: SkillsExtension,
): Promise<Client> {
  const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair()
  const handle = serveStdio(() => createMcpServer(tools, context, { skills }), {
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

  it('gives the instructions with the ask-first rule', async () => {
    const client = await connect(era, registry)

    expect(client.getInstructions()).toBe(INSTRUCTIONS)
    expect(INSTRUCTIONS).toContain(
      'Ask the user before you start an emulator, and before you open an app or a link on a device.',
    )
  })

  it('serves the loupe skill through the skills extension', async () => {
    const warnings: string[] = []
    const catalog = await loadSkills(skillsFolder(), {
      onWarning: ({ message }) => warnings.push(message),
    })
    const client = await connect(era, registry, undefined, catalog)
    const skills = new SkillsClient(client)

    const listing = await skills.list()
    const file = await skills.read(listing.skills[0]!)

    expect(warnings).toEqual([])
    expect(skills.supported).toBe(true)
    expect(listing.skills.map((skill) => skill.frontmatter.name)).toEqual([
      'loupe',
    ])
    expect(file.verified).toBe(true)
    expect(file.body).toMatch(/^\s*# loupe\n/)
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

  it('shows a screenshot as an image block, after its JSON', async () => {
    const adb = 'adb -s emulator-5554'
    const shot = recorded('api-36/none/rotation-1/settings.png')
    const { context } = fakeContext(
      byCommand({
        'adb devices -l': recorded('api-36/host/adb-devices-l.txt'),
        [`${adb} shell getprop`]: recorded('api-36/device/getprop.txt'),
        [`${adb} shell dumpsys window displays`]: recorded(
          'api-36/none/rotation-1/settings/dumpsys-window-displays.txt',
        ),
        [`${adb} exec-out screencap -p`]: shot,
      }),
    )
    const dir = await mkdtemp(path.join(os.tmpdir(), 'loupe-mcp-'))
    closers.push(() => rm(dir, { recursive: true, force: true }))
    const out = path.join(dir, 'settings.png')
    const client = await connect(era, registry, context)

    const result = await client.callTool({
      name: 'screenshot',
      arguments: { out },
    })

    expect(result.content).toMatchObject([
      {
        type: 'text',
        text: expect.stringContaining(`"file":${JSON.stringify(out)}`),
      },
      {
        type: 'image',
        mimeType: 'image/png',
        data: (shot.stdout as Buffer).toString('base64'),
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

describe.each(ERAS)(
  'the MCP server, progress and cancel, protocol $protocol',
  (era) => {
    it('sends the progress of a command to a client that asks for it', async () => {
      const count = defineCommand({
        name: 'count',
        summary: 'Counts to three',
        input: z.object({}),
        output: z.object({}),
        run: (_input, { progress }) => {
          for (const step of [1, 2, 3]) {
            progress?.({ progress: step, total: 3, message: `step ${step}` })
          }
          return {}
        },
      })
      const client = await connect(era, createRegistry([count]))
      const updates: unknown[] = []

      await client.callTool(
        { name: 'count', arguments: {} },
        { onprogress: (update) => updates.push(update) },
      )

      expect(updates).toEqual([
        { progress: 1, total: 3, message: 'step 1' },
        { progress: 2, total: 3, message: 'step 2' },
        { progress: 3, total: 3, message: 'step 3' },
      ])
    })

    it('aborts the signal of the command when the client cancels the call', async () => {
      let started = () => {}
      const running = new Promise<void>((resolve) => (started = resolve))
      let aborted = () => {}
      const stopped = new Promise<void>((resolve) => (aborted = resolve))
      const hang = defineCommand({
        name: 'hang',
        summary: 'Waits for a cancel',
        input: z.object({}),
        output: z.object({}),
        run: async (_input, { signal }) => {
          started()
          await new Promise((resolve) =>
            signal?.addEventListener('abort', resolve),
          )
          aborted()
          throwIfCancelled(signal)
          return {}
        },
      })
      const client = await connect(era, createRegistry([hang]))
      const controller = new AbortController()

      const call = client.callTool(
        { name: 'hang', arguments: {} },
        { signal: controller.signal },
      )
      await running
      controller.abort()

      await expect(call).rejects.toThrow()
      await stopped
    })
  },
)

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
