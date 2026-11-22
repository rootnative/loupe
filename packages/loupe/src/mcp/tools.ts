import { readFile } from 'node:fs/promises'
import {
  type Command,
  inputJsonSchema,
  type JsonSchema,
  outputJsonSchema,
  type Registry,
} from '../core/command'
import { type CommandResult } from '../core/run-command'
import { round2 } from '../core/units'

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

/**
 * The result of an MCP `tools/call`. A type, not an interface, so that it
 * fits the SDK's result type, which has an index signature.
 */
export type McpToolResult = {
  content: ContentBlock[]
  structuredContent?: JsonObject
  isError?: true
}

export type TextBlock = { type: 'text'; text: string }
export type ImageBlock = { type: 'image'; data: string; mimeType: 'image/png' }
export type ContentBlock = TextBlock | ImageBlock

/**
 * The largest PNG in an image block, in bytes: 5 MB as base64, the most
 * that Claude takes for one image.
 */
export const IMAGE_LIMIT = 3_750_000

function megabytes(bytes: number): string {
  return `${round2(bytes / 1_000_000)} MB`
}

/**
 * Reads each PNG for an image block. A file that loupe can't read, or a
 * PNG over `limit`, gives a text block that says why the image isn't there.
 */
export async function imageBlocks(
  files: readonly string[],
  limit = IMAGE_LIMIT,
): Promise<ContentBlock[]> {
  return Promise.all(
    files.map(async (file): Promise<ContentBlock> => {
      let png: Buffer
      try {
        png = await readFile(file)
      } catch (error) {
        const why = error instanceof Error ? error.message : String(error)
        return {
          type: 'text',
          text: `loupe can't read ${file} to show it: ${why}`,
        }
      }
      if (png.length > limit) {
        return {
          type: 'text',
          text: `loupe left the image of ${file} out of this result: the PNG has ${megabytes(png.length)}, and an image block takes ${megabytes(limit)} at most. Give a scale, for example 0.5, or a crop to make it smaller.`,
        }
      }
      return {
        type: 'image',
        data: png.toString('base64'),
        mimeType: 'image/png',
      }
    }),
  )
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
