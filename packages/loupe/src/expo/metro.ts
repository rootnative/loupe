import { createHash } from 'node:crypto'
import { z } from 'zod'
import { type CommandContext } from '../core/context'
import { LoupeError, throwIfCancelled } from '../core/errors'

/** The port of `npx expo start` when the user gives none. */
export const DEFAULT_PORT = 8081
/** A cold bundle of a large app can take minutes. */
export const DEFAULT_BUNDLE_TIMEOUT = 300_000
// Metro gives its status and the manifest at once, also while it builds.
const REQUEST_TIMEOUT = 10_000

export const portField = z
  .number()
  .int()
  .min(1)
  .max(65_535)
  .optional()
  .describe(
    `The port of Metro on this machine (npx expo start). ${DEFAULT_PORT} by default.`,
  )

/**
 * Metro on this machine. loupe asks 127.0.0.1 only, also when Metro gives
 * the address of the machine on the LAN or a tunnel.
 */
export const metroBase = (port: number): string => `http://127.0.0.1:${port}`

// The headers of the manifest request of Expo Go on Android (round 10).
const MANIFEST_HEADERS = {
  'expo-platform': 'android',
  accept: 'application/expo+json,application/json',
}

const manifestSchema = z.object({
  launchAsset: z.object({ url: z.string() }),
  extra: z
    .object({
      expoClient: z
        .object({
          name: z.string().optional(),
          slug: z.string().optional(),
          sdkVersion: z.string().optional(),
        })
        .optional(),
      expoGo: z
        .object({
          developer: z
            .object({ projectRoot: z.string().optional() })
            .optional(),
        })
        .optional(),
    })
    .optional(),
})

/** What loupe reads from the manifest that Metro gives Expo Go. */
export interface ExpoApp {
  name?: string
  slug?: string
  /** For example `58.0.0`. */
  sdkVersion?: string
  /** The folder of the app on this machine. */
  projectRoot?: string
  /** The path and query of the launch bundle on Metro. */
  bundlePath: string
}

export interface BundleReading {
  ms: number
  bytes: number
  sha256: string
}

interface MetroRequest {
  port: number
  path: string
  /** What loupe asks for, for the messages: "the manifest". */
  what: string
  timeout: number
  headers?: Record<string, string>
}

const noServer = (port: number): string =>
  `Nothing answers on port ${port}. Ask the user to start Metro with "npx expo start" in the folder of the app, or give the port of Metro.`

function isRefused(error: unknown): boolean {
  const cause = error instanceof Error ? error.cause : undefined
  return (
    error instanceof TypeError &&
    typeof cause === 'object' &&
    cause !== null &&
    'code' in cause &&
    cause.code === 'ECONNREFUSED'
  )
}

/**
 * Asks Metro for one path, and reads the answer with `read`, within one
 * time limit and the caller's cancel. Each failure becomes a LoupeError.
 */
async function askMetro<T>(
  context: CommandContext,
  { port, path, what, timeout, headers }: MetroRequest,
  read: (response: Response) => Promise<T>,
): Promise<T> {
  throwIfCancelled(context.signal)
  const limit = AbortSignal.timeout(timeout)
  const signal = context.signal
    ? AbortSignal.any([limit, context.signal])
    : limit
  try {
    const response = await context.fetch(`${metroBase(port)}${path}`, {
      headers,
      signal,
    })
    return await read(response)
  } catch (error) {
    if (error instanceof LoupeError) throw error
    throwIfCancelled(context.signal)
    if (limit.aborted) {
      throw new LoupeError(
        'timeout',
        `Metro on port ${port} didn't give ${what} in ${Math.round(timeout / 1000)} s.`,
      )
    }
    if (isRefused(error)) throw new LoupeError('no_server', noServer(port))
    throw new LoupeError(
      'tool_failed',
      `loupe couldn't get ${what} from Metro on port ${port}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    )
  }
}

/** Checks that Metro answers on the port. */
export async function readMetroStatus(
  context: CommandContext,
  port: number,
): Promise<void> {
  const status = await askMetro(
    context,
    { port, path: '/status', what: 'its status', timeout: REQUEST_TIMEOUT },
    (response) => response.text(),
  )
  if (!status.includes('packager-status:running')) {
    throw new LoupeError(
      'no_server',
      `Something answers on port ${port}, but it isn't Metro. Give the port that "npx expo start" prints.`,
    )
  }
}

/** Reads the app from the manifest that Metro gives Expo Go on Android. */
export async function readExpoApp(
  context: CommandContext,
  port: number,
): Promise<ExpoApp> {
  const manifest = await askMetro(
    context,
    {
      port,
      path: '/',
      what: 'the manifest',
      timeout: REQUEST_TIMEOUT,
      headers: MANIFEST_HEADERS,
    },
    async (response) => {
      const text = await response.text()
      if (!response.ok) return undefined
      try {
        return manifestSchema.safeParse(JSON.parse(text)).data
      } catch {
        return undefined
      }
    },
  )
  if (!manifest) {
    throw new LoupeError(
      'unsupported',
      `Metro on port ${port} gives no Expo manifest. The Expo commands need the dev server of the Expo CLI: "npx expo start".`,
    )
  }

  const client = manifest.extra?.expoClient
  const bundle = new URL(manifest.launchAsset.url, metroBase(port))
  return {
    name: client?.name,
    slug: client?.slug,
    sdkVersion: client?.sdkVersion,
    projectRoot: manifest.extra?.expoGo?.developer?.projectRoot,
    bundlePath: `${bundle.pathname}${bundle.search}`,
  }
}

/** Metro's own words for a bundle that it couldn't build, on one line. */
function bundleError(status: number, text: string): string {
  let detail = text
  try {
    const json: unknown = JSON.parse(text)
    if (typeof json === 'object' && json !== null) {
      detail = ['type', 'message']
        .map((key) => (json as Record<string, unknown>)[key])
        .filter((value) => typeof value === 'string')
        .join(': ')
    }
  } catch {
    // Not Metro's JSON: the text itself is the detail.
  }
  const line = detail
    .split('\n')
    .map((part) => part.trim())
    .find(Boolean)
  return `Metro couldn't build the bundle (HTTP ${status})${line ? `: ${line.slice(0, 500)}` : '.'} Fix the code of the app, then run expo-warm again.`
}

/** Gets the whole bundle, and gives its time, size and SHA-256. */
export async function fetchBundle(
  context: CommandContext,
  port: number,
  path: string,
  timeout: number,
): Promise<BundleReading> {
  const start = performance.now()
  return askMetro(
    context,
    { port, path, what: 'the bundle', timeout },
    async (response) => {
      if (!response.ok) {
        throw new LoupeError(
          'tool_failed',
          bundleError(response.status, await response.text()),
        )
      }
      const body = Buffer.from(await response.arrayBuffer())
      return {
        ms: Math.round(performance.now() - start),
        bytes: body.length,
        sha256: createHash('sha256').update(body).digest('hex'),
      }
    },
  )
}

export interface WarmOptions {
  port?: number
  timeout?: number
}

/**
 * Asks Metro for its status, the manifest and the launch bundle, as Expo
 * Go does on its first open. Then Metro has the bundle ready, and Expo Go
 * doesn't wait for a cold one. These are the first 3 of `total` progress
 * steps.
 */
export async function warmExpo(
  context: CommandContext,
  { port = DEFAULT_PORT, timeout = DEFAULT_BUNDLE_TIMEOUT }: WarmOptions,
  total = 3,
) {
  await readMetroStatus(context, port)
  context.progress?.({ progress: 1, total, message: 'Metro runs.' })
  const app = await readExpoApp(context, port)
  context.progress?.({
    progress: 2,
    total,
    message: 'Metro builds the bundle.',
  })
  const bundle = await fetchBundle(context, port, app.bundlePath, timeout)
  context.progress?.({ progress: 3, total })
  return {
    server: metroBase(port),
    link: `exp://127.0.0.1:${port}`,
    app: { name: app.name, slug: app.slug, sdkVersion: app.sdkVersion },
    projectRoot: app.projectRoot,
    bundle: { path: app.bundlePath, ...bundle },
  }
}
