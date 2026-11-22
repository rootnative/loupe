import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { flagsOf } from '../cli/flags'
import { registry } from '../commands'
import { createRegistry, defineCommand } from '../core/command'
import { runCommand } from '../core/run-command'
import { byCommand, fakeContext, missingTool } from '../testing/fake-exec'
import { toolOf, toolResult, toolsOf } from './tools'

const READ_ONLY = [
  'check',
  'devices',
  'insets',
  'measure',
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
    expect(JSON.parse(result.content[0]!.text)).toEqual({
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
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({
      error: { code: 'tool_missing' },
    })
  })
})
