import { createServer, type Server, type Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { connectRunner } from './runner-client'

type Reply = (request: Record<string, unknown>, socket: Socket) => void

const servers: Server[] = []
const sockets: Socket[] = []
afterEach(() => {
  for (const socket of sockets.splice(0)) socket.destroy()
  for (const server of servers.splice(0)) server.close()
})

/** A runner that answers each line with `reply`, on a free port. */
function fakeRunner(reply: Reply): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer((socket) => {
      sockets.push(socket)
      let buffer = ''
      socket.on('data', (chunk) => {
        buffer += chunk.toString()
        for (let end; (end = buffer.indexOf('\n')) >= 0;) {
          reply(JSON.parse(buffer.slice(0, end)), socket)
          buffer = buffer.slice(end + 1)
        }
      })
    })
    servers.push(server)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve(typeof address === 'object' && address ? address.port : 0)
    })
  })
}

const send = (socket: Socket, answer: unknown): void => {
  socket.write(`${JSON.stringify(answer)}\n`)
}

async function connected(reply: Reply) {
  const client = await connectRunner(await fakeRunner(reply))
  if (!client) throw new Error('No connection to the fake runner.')
  return client
}

describe('connectRunner', () => {
  it('gives undefined when nothing listens on the port', async () => {
    const port = await fakeRunner(() => undefined)
    servers.splice(0)[0]?.close()

    expect(await connectRunner(port)).toBeUndefined()
  })

  it('sends one JSON line with an id, and gives the answer of that id', async () => {
    const seen: unknown[] = []
    const client = await connected((request, socket) => {
      seen.push(request)
      send(socket, { id: request.id, ok: true, ms: 3, orientation: 'portrait' })
    })

    expect(await client.request({ cmd: 'orientation' })).toEqual({
      id: 1,
      ok: true,
      ms: 3,
      orientation: 'portrait',
    })
    expect(await client.request({ cmd: 'tap', x: 10, y: 20 })).toMatchObject({
      id: 2,
    })
    expect(seen).toEqual([
      { cmd: 'orientation', id: 1 },
      { cmd: 'tap', x: 10, y: 20, id: 2 },
    ])
  })

  it('takes an answer that comes in two parts', async () => {
    const client = await connected((request, socket) => {
      const line = `${JSON.stringify({ id: request.id, ok: true, png: 'x'.repeat(100) })}\n`
      socket.write(line.slice(0, 40))
      setTimeout(() => socket.write(line.slice(40)), 10)
    })

    expect(await client.request({ cmd: 'screenshot' })).toMatchObject({
      png: 'x'.repeat(100),
    })
  })

  it('fails with tool_failed and the reason of the runner', async () => {
    const client = await connected((request, socket) => {
      send(socket, {
        id: request.id,
        ok: false,
        error: 'No element matches identifier == "save".',
        issues: ['No element matches identifier == "save".'],
      })
    })

    await expect(
      client.request({ cmd: 'tap', identifier: 'save' }),
    ).rejects.toMatchObject({
      code: 'tool_failed',
      message:
        'The iOS runner couldn\'t do "tap": No element matches identifier == "save".',
    })
  })

  it('fails with timeout, and a late answer is not the next answer', async () => {
    const client = await connected((request, socket) => {
      if (request.cmd === 'tree') {
        setTimeout(() => send(socket, { id: request.id, ok: true }), 80)
      }
    })

    await expect(
      client.request({ cmd: 'tree' }, { timeout: 20 }),
    ).rejects.toMatchObject({
      code: 'timeout',
      message: 'The iOS runner gave no answer to "tree" in 20 ms.',
    })
    await expect(client.request({ cmd: 'ping' })).rejects.toMatchObject({
      code: 'tool_failed',
    })
  })

  it('leaves out an answer with another id', async () => {
    const client = await connected((request, socket) => {
      send(socket, { id: 99, ok: true, stale: true })
      send(socket, { id: request.id, ok: true })
    })

    expect(await client.request({ cmd: 'ping' })).toEqual({ id: 1, ok: true })
  })

  it('fails when the runner closes the connection or gives no JSON', async () => {
    const closing = await connected((_request, socket) => socket.destroy())
    await expect(closing.request({ cmd: 'home' })).rejects.toMatchObject({
      code: 'tool_failed',
      message: 'The iOS runner closed the connection.',
    })

    const broken = await connected((_request, socket) =>
      socket.write('not JSON\n'),
    )
    await expect(broken.request({ cmd: 'home' })).rejects.toMatchObject({
      code: 'tool_failed',
      message: "The iOS runner gave an answer that isn't JSON.",
    })
  })

  it('takes one request at a time', async () => {
    const client = await connected(() => undefined)
    const first = client.request({ cmd: 'tree' }, { timeout: 30 })

    expect(() => client.request({ cmd: 'ping' })).toThrow(
      expect.objectContaining({ code: 'internal' }),
    )
    await expect(first).rejects.toMatchObject({ code: 'timeout' })
  })
})
