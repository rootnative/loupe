/** One recorded HTTP answer. */
export interface FakeResponse {
  /** Default: 200. */
  status?: number
  headers?: Record<string, string>
  body?: string
}

/**
 * Answers one request: a response, an error to throw (as `fetch` throws
 * on a refused connection), or a function for a slow or special server.
 */
export type FakeRoute =
  FakeResponse | Error | ((url: URL, init?: RequestInit) => Promise<Response>)

export interface FakeRequest {
  url: string
  headers: Record<string, string>
}

/**
 * A `fetch` that answers from a table keyed by the path of the URL, for
 * example `/status`. A list answers the requests in order, and its last
 * item answers each request after that. Each request is recorded.
 */
export function fakeFetch(
  routes: Readonly<Record<string, FakeRoute | readonly FakeRoute[]>>,
): { fetch: typeof fetch; requests: FakeRequest[] } {
  const requests: FakeRequest[] = []
  const counts = new Map<string, number>()

  const fake: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input)
    requests.push({
      url: url.href,
      headers: Object.fromEntries(new Headers(init?.headers)),
    })
    init?.signal?.throwIfAborted()

    const entry = routes[url.pathname]
    if (entry === undefined) {
      throw new Error(`No fake response for: ${url.href}`)
    }
    let route: FakeRoute
    if (Array.isArray(entry)) {
      const count = counts.get(url.pathname) ?? 0
      counts.set(url.pathname, count + 1)
      route = entry[Math.min(count, entry.length - 1)]
    } else {
      route = entry as FakeRoute
    }

    if (route instanceof Error) throw route
    if (typeof route === 'function') return route(url, init)
    return new Response(route.body ?? '', {
      status: route.status ?? 200,
      headers: route.headers,
    })
  }

  return { fetch: fake, requests }
}

/** The error that Node's `fetch` throws when nothing listens on the port. */
export function refused(): Error {
  const cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1'), {
    code: 'ECONNREFUSED',
  })
  return new TypeError('fetch failed', { cause })
}
