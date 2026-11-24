import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { type CommandContext, type ProgressUpdate } from '../core/context'
import { runCommand } from '../core/run-command'
import { fakeContext } from '../testing/fake-exec'
import { type FakeRoute, fakeFetch, refused } from '../testing/fake-fetch'
import {
  BUNDLE,
  BUNDLE_PATH,
  METRO_MANIFEST as MANIFEST,
  METRO_STATUS as STATUS,
  metroRoutes,
} from '../testing/metro'
import { registry } from './index'

function contextWith(routes: Record<string, FakeRoute>): {
  context: CommandContext
  requests: ReturnType<typeof fakeFetch>['requests']
} {
  const { fetch, requests } = fakeFetch(routes)
  const { context } = fakeContext(() => undefined)
  return { context: { ...context, fetch }, requests }
}

describe('expo-warm', () => {
  it('reads the app from the manifest, and hashes the bundle', async () => {
    const { context, requests } = contextWith(metroRoutes())

    const result = await runCommand(registry, 'expo-warm', {}, context)

    expect(result).toMatchObject({
      ok: true,
      data: {
        server: 'http://127.0.0.1:8081',
        link: 'exp://127.0.0.1:8081',
        app: { name: 'Probe app', slug: 'probe-app', sdkVersion: '58.0.0' },
        projectRoot: '/home/runner/work/loupe/loupe/apps/probe-app',
        bundle: {
          path: expect.stringMatching(
            /^\/apps\/probe-app\/index\.ts\.bundle\?platform=android&dev=true&/,
          ),
          bytes: BUNDLE.length,
          sha256: createHash('sha256').update(BUNDLE).digest('hex'),
        },
      },
    })
    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      '/status',
      '/',
      BUNDLE_PATH,
    ])
    expect(requests[1]?.headers).toMatchObject({ 'expo-platform': 'android' })
  })

  it('asks the port that the input gives', async () => {
    const { context, requests } = contextWith(metroRoutes())

    const result = await runCommand(
      registry,
      'expo-warm',
      { port: 19000 },
      context,
    )

    expect(result).toMatchObject({
      ok: true,
      data: { link: 'exp://127.0.0.1:19000' },
    })
    for (const request of requests) {
      expect(new URL(request.url).host).toBe('127.0.0.1:19000')
    }
  })

  it('gets the bundle from 127.0.0.1 when Metro gives a LAN address', async () => {
    const { context, requests } = contextWith({
      ...metroRoutes(),
      '/': { body: MANIFEST.replaceAll('127.0.0.1:8081', '192.168.1.5:8081') },
    })

    const result = await runCommand(registry, 'expo-warm', {}, context)

    expect(result.ok).toBe(true)
    expect(requests.map((request) => new URL(request.url).hostname)).toEqual([
      '127.0.0.1',
      '127.0.0.1',
      '127.0.0.1',
    ])
  })

  it('gives no_server when nothing answers on the port', async () => {
    const { context } = contextWith({ '/status': refused() })

    const result = await runCommand(registry, 'expo-warm', {}, context)

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'no_server',
        message: expect.stringContaining('npx expo start'),
      },
    })
  })

  it('gives no_server when another server answers on the port', async () => {
    const { context } = contextWith({
      '/status': { status: 404, body: '<html>Not found</html>' },
    })

    const result = await runCommand(registry, 'expo-warm', {}, context)

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'no_server', message: expect.stringContaining("isn't") },
    })
  })

  it('gives unsupported for a Metro with no Expo manifest', async () => {
    const { context } = contextWith({
      '/status': { body: STATUS },
      '/': { body: '<!doctype html><title>React Native</title>' },
    })

    const result = await runCommand(registry, 'expo-warm', {}, context)

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'unsupported' },
    })
  })

  it("gives Metro's first line when the bundle doesn't build", async () => {
    const { context } = contextWith(
      metroRoutes({
        status: 500,
        body: JSON.stringify({
          type: 'TransformError',
          message:
            'SyntaxError: /app/App.tsx: Unexpected token (12:4)\n\n  11 |\n> 12 |   <View',
          errors: [{ description: 'Unexpected token' }],
        }),
      }),
    )

    const result = await runCommand(registry, 'expo-warm', {}, context)

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'tool_failed',
        message:
          "Metro couldn't build the bundle (HTTP 500): TransformError: SyntaxError: /app/App.tsx: Unexpected token (12:4) Fix the code of the app, then run expo-warm again.",
      },
    })
  })

  it('gives timeout when the bundle takes too long', async () => {
    const { context } = contextWith(
      metroRoutes(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(init.signal?.reason),
            )
          }),
      ),
    )

    const result = await runCommand(
      registry,
      'expo-warm',
      { timeout: 1000 },
      context,
    )

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'timeout',
        message: "Metro on port 8081 didn't give the bundle in 1 s.",
      },
    })
  })

  it('stops with cancelled when the caller cancels during the bundle', async () => {
    const controller = new AbortController()
    const { context } = contextWith(
      metroRoutes((_url, init) => {
        controller.abort()
        return Promise.reject(init?.signal?.reason)
      }),
    )

    const result = await runCommand(
      registry,
      'expo-warm',
      {},
      { ...context, signal: controller.signal },
    )

    expect(result).toMatchObject({ ok: false, error: { code: 'cancelled' } })
  })

  it('gives its progress after each of the three requests', async () => {
    const updates: ProgressUpdate[] = []
    const { context } = contextWith(metroRoutes())

    await runCommand(
      registry,
      'expo-warm',
      {},
      { ...context, progress: (update) => updates.push(update) },
    )

    expect(updates.map((update) => update.progress)).toEqual([1, 2, 3])
    expect(updates.every((update) => update.total === 3)).toBe(true)
  })
})
