import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { type DetachedOptions, type SpawnDetached } from '../../core/exec'
import { fakeContext, missingTool } from '../../testing/fake-exec'
import { version } from '../../version'
import { type IosTarget } from '../select'
import { ensureRunner, IDLE_SECONDS, stateFolder, stopRunner } from './runner'

const TARGET: IosTarget = {
  udid: 'AAAAAAAA-0000-4000-8000-000000000001',
  name: 'iPhone 16 Pro',
  os: 'iOS 18.6',
}
const FAST = { startTimeout: 2000, poll: 20 }

const temp = mkdtempSync(path.join(tmpdir(), 'loupe-runner-'))
afterAll(() => rmSync(temp, { recursive: true, force: true }))

/** A package folder with a runner in it. */
const root = path.join(temp, 'package')
const xctestrun = path.join(root, 'dist', 'ios-runner', 'LoupeRunner.xctestrun')
mkdirSync(path.dirname(xctestrun), { recursive: true })
writeFileSync(xctestrun, '')

const servers: Server[] = []
const sockets: Socket[] = []
afterEach(() => {
  for (const socket of sockets.splice(0)) socket.destroy()
  for (const server of servers.splice(0)) server.close()
})

interface Started {
  args: string[]
  options: DetachedOptions
  requests: Record<string, unknown>[]
  killed: boolean
}

/**
 * xcodebuild as the tests see it: `behave` says what the started tool does.
 * `runner` listens on the port of its environment, as the real runner
 * does, and takes only requests with its token.
 */
function fakeXcodebuild(
  behave: 'runner' | 'exits' | 'silent' | 'missing' = 'runner',
) {
  const starts: Started[] = []
  const spawnDetached: SpawnDetached = async (file, args, options) => {
    if (behave === 'missing') throw missingTool(file)
    const started: Started = {
      args: [file, ...args],
      options,
      requests: [],
      killed: false,
    }
    starts.push(started)
    if (behave === 'runner') {
      const token = options.env.TEST_RUNNER_LOUPE_TOKEN
      const server = createServer((socket) => {
        sockets.push(socket)
        let buffer = ''
        socket.on('data', (chunk) => {
          buffer += chunk.toString()
          for (let end; (end = buffer.indexOf('\n')) >= 0;) {
            const request = JSON.parse(buffer.slice(0, end))
            buffer = buffer.slice(end + 1)
            started.requests.push(request)
            const ok = request.token === token
            socket.write(`${JSON.stringify({ id: request.id, ok })}\n`)
            if (ok && request.cmd === 'quit') server.close()
          }
        })
      })
      servers.push(server)
      // The real runner listens a while after xcodebuild starts.
      setTimeout(
        () =>
          server.listen(
            Number(options.env.TEST_RUNNER_LOUPE_PORT),
            '127.0.0.1',
          ),
        60,
      )
    }
    return {
      pid: 4000 + starts.length,
      exitCode: () => (behave === 'exits' ? 70 : undefined),
      kill: () => {
        started.killed = true
      },
    }
  }
  return { starts, spawnDetached }
}

let folders = 0
function setup(behave?: Parameters<typeof fakeXcodebuild>[0]) {
  const state = path.join(temp, `state-${++folders}`)
  const xcodebuild = fakeXcodebuild(behave)
  const { context } = fakeContext(
    () => undefined,
    { LOUPE_STATE_DIR: state },
    'darwin',
    xcodebuild.spawnDetached,
  )
  const recordFile = path.join(state, `runner-${TARGET.udid}.json`)
  return { ...xcodebuild, context, state, recordFile }
}

describe('ensureRunner', () => {
  it('starts the runner of the package, waits for it, and keeps a record', async () => {
    const { context, starts, state, recordFile } = setup()
    const client = await ensureRunner(context, TARGET, { ...FAST, root })

    expect(starts).toHaveLength(1)
    expect(starts[0]?.args).toEqual([
      'xcodebuild',
      'test-without-building',
      '-xctestrun',
      xctestrun,
      '-destination',
      `id=${TARGET.udid}`,
      '-derivedDataPath',
      path.join(state, `derived-${TARGET.udid}`),
    ])
    const { env, logFile } = starts[0]?.options ?? { env: {}, logFile: '' }
    expect(logFile).toBe(path.join(state, `runner-${TARGET.udid}.log`))
    expect(env.TEST_RUNNER_LOUPE_IDLE_SECONDS).toBe(String(IDLE_SECONDS))
    expect(env.TEST_RUNNER_LOUPE_TOKEN).toMatch(/^[0-9a-f]{32}$/)

    expect(JSON.parse(readFileSync(recordFile, 'utf8'))).toEqual({
      udid: TARGET.udid,
      port: Number(env.TEST_RUNNER_LOUPE_PORT),
      token: env.TEST_RUNNER_LOUPE_TOKEN,
      pid: 4001,
      version,
    })
    if (process.platform !== 'win32') {
      expect(statSync(recordFile).mode & 0o077).toBe(0)
    }

    await client.request({ cmd: 'orientation' })
    expect(starts[0]?.requests.at(-1)).toMatchObject({
      cmd: 'orientation',
      token: env.TEST_RUNNER_LOUPE_TOKEN,
    })
    client.close()
  })

  it('connects to the runner of the record, and starts no second one', async () => {
    const { context, starts } = setup()
    ;(await ensureRunner(context, TARGET, { ...FAST, root })).close()
    const again = await ensureRunner(context, TARGET, { ...FAST, root })

    expect(starts).toHaveLength(1)
    await expect(again.request({ cmd: 'home' })).resolves.toMatchObject({
      ok: true,
    })
    again.close()
  })

  it('starts a new runner when the one of the record is gone', async () => {
    const { context, starts } = setup()
    ;(await ensureRunner(context, TARGET, { ...FAST, root })).close()
    for (const socket of sockets.splice(0)) socket.destroy()
    await new Promise((resolve) => servers.splice(0)[0]?.close(resolve))

    ;(await ensureRunner(context, TARGET, { ...FAST, root })).close()
    expect(starts).toHaveLength(2)
    expect(starts[1]?.options.env.TEST_RUNNER_LOUPE_TOKEN).not.toBe(
      starts[0]?.options.env.TEST_RUNNER_LOUPE_TOKEN,
    )
  })

  it('stops the runner of another loupe version, and starts its own', async () => {
    const { context, starts, recordFile } = setup()
    ;(await ensureRunner(context, TARGET, { ...FAST, root })).close()
    const record = JSON.parse(readFileSync(recordFile, 'utf8'))
    writeFileSync(
      recordFile,
      JSON.stringify({ ...record, version: '0.0.0-old' }),
    )

    ;(await ensureRunner(context, TARGET, { ...FAST, root })).close()
    expect(starts).toHaveLength(2)
    expect(starts[0]?.requests.at(-1)).toMatchObject({ cmd: 'quit' })
    expect(JSON.parse(readFileSync(recordFile, 'utf8')).version).toBe(version)
  })

  it('fails with the log when xcodebuild ends before the runner answers', async () => {
    const { context, state } = setup('exits')

    await expect(
      ensureRunner(context, TARGET, { ...FAST, root }),
    ).rejects.toMatchObject({
      code: 'tool_failed',
      message: `xcodebuild ended with 70 before the iOS runner answered on iPhone 16 Pro. Its log is ${path.join(state, `runner-${TARGET.udid}.log`)}.`,
    })
  })

  it('stops xcodebuild and gives timeout when the runner never answers', async () => {
    const { context, starts, recordFile } = setup('silent')

    await expect(
      ensureRunner(context, TARGET, { startTimeout: 1000, poll: 20, root }),
    ).rejects.toMatchObject({
      code: 'timeout',
      message: expect.stringMatching(
        /^The iOS runner didn't answer on iPhone 16 Pro in 1 s, so loupe stopped it\. Its log is /,
      ),
    })
    expect(starts[0]?.killed).toBe(true)
    expect(() => readFileSync(recordFile)).toThrow()
  })

  it('stops xcodebuild when the caller cancels the call', async () => {
    const { context, starts } = setup('silent')
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 80)

    await expect(
      ensureRunner({ ...context, signal: controller.signal }, TARGET, {
        ...FAST,
        root,
      }),
    ).rejects.toMatchObject({ code: 'cancelled' })
    expect(starts[0]?.killed).toBe(true)
  })

  it('says to install Xcode when there is no xcodebuild', async () => {
    const { context } = setup('missing')

    await expect(
      ensureRunner(context, TARGET, { ...FAST, root }),
    ).rejects.toMatchObject({
      code: 'tool_missing',
      message: "loupe can't find xcodebuild. Install Xcode, then try again.",
    })
  })

  it('fails with tool_missing, and starts nothing, in a copy with no runner', async () => {
    const { context, starts } = setup()

    await expect(
      ensureRunner(context, TARGET, { ...FAST, root: path.join(temp, 'none') }),
    ).rejects.toMatchObject({ code: 'tool_missing' })
    expect(starts).toEqual([])
  })
})

describe('stopRunner', () => {
  it('tells the runner to quit, and removes the record', async () => {
    const { context, starts, recordFile } = setup()
    ;(await ensureRunner(context, TARGET, { ...FAST, root })).close()

    expect(await stopRunner(context, TARGET)).toBe(true)
    expect(starts[0]?.requests.at(-1)).toMatchObject({ cmd: 'quit' })
    expect(() => readFileSync(recordFile)).toThrow()
    expect(await stopRunner(context, TARGET)).toBe(false)
  })
})

describe('stateFolder', () => {
  it("is the user's cache folder, or LOUPE_STATE_DIR", () => {
    const { context: home } = fakeContext(() => undefined, {
      HOME: '/Users/me',
    })
    expect(stateFolder(home)).toBe(
      path.join('/Users/me', 'Library', 'Caches', 'loupe'),
    )
    const { context: set } = fakeContext(() => undefined, {
      HOME: '/Users/me',
      LOUPE_STATE_DIR: '/tmp/state',
    })
    expect(stateFolder(set)).toBe('/tmp/state')
  })
})
