import {
  type Command,
  inputJsonSchema,
  type JsonSchema,
  outputJsonSchema,
  type Registry,
} from '../core/command'
import { type CommandResult } from '../core/run-command'

export type JsonObject = { [key: string]: unknown }

export type ObjectSchema = JsonObject & { type: 'object' }

/** A loupe command as an MCP tool, for `tools/list`. */
export interface McpTool {
  name: string
  description: string
  inputSchema: ObjectSchema
  outputSchema: ObjectSchema
  annotations: { readOnlyHint: boolean }
}

/** The result of an MCP `tools/call`. */
export interface McpToolResult {
  content: { type: 'text'; text: string }[]
  structuredContent?: JsonObject
  isError?: true
}

function toolSchema(
  command: Command,
  side: 'input' | 'output',
  schema: JsonSchema,
): ObjectSchema {
  // MCP reads a schema with no `$schema` as JSON Schema 2020-12, which zod
  // writes. The key costs tokens in each tool list.
  const copy: JsonObject = { ...schema }
  delete copy.$schema
  if (copy.type !== 'object') {
    throw new Error(
      `${command.name}: the ${side} must be an object to be an MCP tool.`,
    )
  }
  return copy as ObjectSchema
}

/**
 * Makes the MCP tool of a command. It throws for an output that isn't an
 * object, so a test finds that command early.
 */
export function toolOf(command: Command): McpTool {
  return {
    name: command.name,
    description: command.summary,
    inputSchema: toolSchema(command, 'input', inputJsonSchema(command)),
    outputSchema: toolSchema(command, 'output', outputJsonSchema(command)),
    annotations: { readOnlyHint: command.readOnly === true },
  }
}

export function toolsOf(registry: Registry): McpTool[] {
  return registry.list().map(toolOf)
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Turns the result of a command into an MCP tool result. A check that ran
 * and failed is a success: its data says that it failed.
 */
export function toolResult(result: CommandResult): McpToolResult {
  if (!result.ok) {
    return {
      content: [
        { type: 'text', text: JSON.stringify({ error: result.error }) },
      ],
      isError: true,
    }
  }

  const text = JSON.stringify(result.data)
  // A parse of the text drops each undefined field, so the structured
  // content and the text hold the same data.
  const data: unknown = JSON.parse(text)
  return {
    content: [{ type: 'text', text }],
    ...(isJsonObject(data) && { structuredContent: data }),
  }
}
