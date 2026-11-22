import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { flagsOf } from '../cli/flags'
import { registry } from '../commands'
import { createRegistry, defineCommand } from '../core/command'
import { runCommand } from '../core/run-command'
import { byCommand, fakeContext, missingTool } from '../testing/fake-exec'
import {
  imageBlocks,
  type McpToolResult,
  toolOf,
  toolResult,
  toolsOf,
} from './tools'

const READ_ONLY = [
  'check',
  'devices',
  'insets',
  'measure',
  'screenshot',
  'ui',
  'version',
  'wait',
]

describe('toolsOf', () => {
  const tools = toolsOf(registry)

  it('gives one tool for each command, with its name and summary', () => {
    expect(tools.map((tool) => tool.name)).toEqual(
      registry.list().map((command) => command.name),
    )
    for (const tool of tools) {
      expect(tool.description).toBe(registry.get(tool.name)?.summary)
    }
  })

  it.each(registry.list().map((command) => command.name))(
    'gives %s object schemas with no $schema key',
    (name) => {
      const tool = tools.find((item) => item.name === name)

      expect(tool?.inputSchema.type).toBe('object')
      expect(tool?.outputSchema.type).toBe('object')
      expect(tool?.inputSchema).not.toHaveProperty('$schema')
      expect(tool?.outputSchema).not.toHaveProperty('$schema')
    },
  )

  it.each(registry.list().map((command) => command.name))(
    'gives %s the same input fields as its CLI flags',
    (name) => {
      const command = registry.get(name)!
      const tool = toolOf(command)
      const properties = (tool.inputSchema.properties ?? {}) as object

      expect(Object.keys(properties)).toEqual(
        flagsOf(command).map((flag) => flag.key),
      )
    },
  )

  it('marks only the commands that read as read-only', () => {
    expect(
      tools
        .filter((tool) => tool.annotations.readOnlyHint)
        .map((tool) => tool.name)
        .sort(),
    ).toEqual(READ_ONLY)
  })

  it('keeps a field description and a default for the agent', () => {
    const tool = toolOf(
      defineCommand({
        name: 'move',
        summary: 'Moves a thing',
        input: z.object({
          steps: z.number().default(1).describe('How many steps'),
        }),
        output: z.object({}),
        run: () => ({}),
      }),
    )

    expect(tool.inputSchema).toMatchObject({
      properties: {
        steps: { type: 'number', default: 1, description: 'How many steps' },
      },
    })
    expect(tool.inputSchema.required ?? []).toEqual([])
  })

  it('refuses a command whose output is not an object', () => {
    const list = defineCommand({
      name: 'list',
      summary: 'Gives a list',
      input: z.object({}),
      output: z.array(z.string()),
      run: () => [],
    })

    expect(() => toolOf(list)).toThrow(
      'list: the output must be an object to be an MCP tool.',
    )
  })
})

function firstText(result: McpToolResult): string {
  const [block] = result.content
  if (block?.type !== 'text') throw new Error('The first block is not text.')
  return block.text
}

describe('toolResult', () => {
  const shot = defineCommand({
    name: 'shot',
    summary: 'Takes a shot',
    input: z.object({ crop: z.string().optional() }),
    output: z.object({ file: z.string(), crop: z.string().optional() }),
    run: ({ crop }) => ({ file: '/tmp/shot.png', crop }),
  })
  const audit = defineCommand({
    name: 'audit',
    summary: 'Checks a thing',
    input: z.object({}),
    output: z.object({ passed: z.boolean() }),
    run: () => ({ passed: false }),
    passed: (data) => data.passed,
  })
  const local = createRegistry([shot, audit])

  it('gives the data as structured content and as the same JSON text', async () => {
    const result = toolResult(await runCommand(local, 'shot', {}))

    expect(result).toEqual({
      content: [{ type: 'text', text: '{"file":"/tmp/shot.png"}' }],
      structuredContent: { file: '/tmp/shot.png' },
    })
  })

  it('keeps a check that failed a success', async () => {
    const result = toolResult(await runCommand(local, 'audit', {}))

    expect(result.isError).toBeUndefined()
    expect(result.structuredContent).toEqual({ passed: false })
  })

  it('gives a failure as an error with its code and message', async () => {
    const result = toolResult(await runCommand(local, 'shot', { crop: 7 }))

    expect(result.isError).toBe(true)
    expect(result.structuredContent).toBeUndefined()
    expect(JSON.parse(firstText(result))).toEqual({
      error: {
        code: 'invalid_input',
        message: expect.stringContaining('crop'),
      },
    })
  })

  it('gives the code of a command of the registry', async () => {
    const { context } = fakeContext(
      byCommand({ 'adb devices -l': missingTool('adb') }),
    )

    const result = toolResult(
      await runCommand(registry, 'devices', {}, context),
    )

    expect(result.isError).toBe(true)
    expect(JSON.parse(firstText(result))).toMatchObject({
      error: { code: 'tool_missing' },
    })
  })
})

describe('imageBlocks', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'loupe-images-'))
  })

  afterEach(() => rm(dir, { recursive: true, force: true }))

  it('gives each PNG as an image block, in base64', async () => {
    const file = path.join(dir, 'shot.png')
    const png = Buffer.from('a small png')
    await writeFile(file, png)

    expect(await imageBlocks([file])).toEqual([
      { type: 'image', data: png.toString('base64'), mimeType: 'image/png' },
    ])
  })

  it('leaves out a PNG over the limit, and says how to make it smaller', async () => {
    const file = path.join(dir, 'big.png')
    await writeFile(file, Buffer.alloc(30_000))

    expect(await imageBlocks([file], 20_000)).toEqual([
      {
        type: 'text',
        text: `loupe left the image of ${file} out of this result: the PNG has 0.03 MB, and an image block takes 0.02 MB at most. Open the file, or make the image smaller: a screenshot with a scale (for example 0.5) or a crop, or a sweep of fewer links.`,
      },
    ])
  })

  it("says when it can't read a file", async () => {
    const file = path.join(dir, 'gone.png')

    expect(await imageBlocks([file])).toEqual([
      {
        type: 'text',
        text: expect.stringContaining(`loupe can't read ${file} to show it:`),
      },
    ])
  })
})
