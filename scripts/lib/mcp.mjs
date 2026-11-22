// Starts the built `loupe mcp` the way an MCP client does, for the smoke run.

import { createWriteStream } from 'node:fs'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'

/**
 * Connects a client to `node <bin> mcp`. The SDK gives the server only a
 * small part of the environment by default, so the server gets all of it
 * here: it needs ANDROID_HOME to find adb. The server's stderr goes to
 * `stderrFile`. With `pin`, the client asks for that protocol version;
 * with none, it speaks 2025-11-25.
 */
export async function connectMcp(bin, stderrFile, pin) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([, value]) => value !== undefined),
  )
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [bin, 'mcp'],
    env,
    stderr: 'pipe',
  })
  transport.stderr?.pipe(createWriteStream(stderrFile))
  const client = new Client(
    { name: 'loupe-smoke', version: '0.0.0' },
    pin ? { versionNegotiation: { mode: { pin } } } : {},
  )
  await client.connect(transport)
  return client
}

/** The text of the first text block, parsed as JSON; undefined when none. */
export function firstJson(result) {
  const block = result.content?.find((item) => item.type === 'text')
  try {
    return block ? JSON.parse(block.text) : undefined
  } catch {
    return undefined
  }
}
