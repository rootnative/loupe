import { type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { SafeAreaInsetsContext } from 'react-native-safe-area-context'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LoupeProbe } from './probe'
import { PROBE_FORMAT, PROBE_PREFIX } from './report'

// The real React Native can't run in Node. This stand-in keeps the props of
// each view, and react-dom/server runs the hooks.
const native = vi.hoisted(() => ({
  views: [] as Record<string, unknown>[],
  window: { width: 914.29, height: 411.43, scale: 2.625, fontScale: 1 },
  colorScheme: 'dark' as string | null,
  isRTL: false,
}))

vi.mock('react-native', () => ({
  View: (props: Record<string, unknown>) => {
    native.views.push(props)
    return null
  },
  StyleSheet: { create: <T,>(styles: T): T => styles },
  I18nManager: {
    get isRTL() {
      return native.isRTL
    },
  },
  useWindowDimensions: () => native.window,
  useColorScheme: () => native.colorScheme,
}))

vi.mock('react-native-safe-area-context', async () => {
  const { createContext } = await import('react')
  return { SafeAreaInsetsContext: createContext(null) }
})

const insets = { top: 0, right: 48.76, bottom: 0, left: 24 }

function render(element: ReactElement): Record<string, unknown>[] {
  native.views = []
  renderToStaticMarkup(element)
  return native.views
}

function reportOf(view: Record<string, unknown> | undefined): unknown {
  const label = String(view?.accessibilityLabel)
  expect(label.startsWith(PROBE_PREFIX)).toBe(true)
  return JSON.parse(label.slice(PROBE_PREFIX.length))
}

beforeEach(() => {
  vi.stubGlobal('__DEV__', true)
  native.colorScheme = 'dark'
  native.isRTL = false
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('LoupeProbe', () => {
  it('renders one view with the report in its label', () => {
    const views = render(
      <SafeAreaInsetsContext.Provider value={insets}>
        <LoupeProbe route="/settings" />
      </SafeAreaInsetsContext.Provider>,
    )

    expect(views).toHaveLength(1)
    expect(reportOf(views[0])).toEqual({
      v: PROBE_FORMAT,
      insets,
      window: { width: 914.29, height: 411.43 },
      scale: 2.625,
      direction: 'ltr',
      colorScheme: 'dark',
      route: '/settings',
    })
  })

  it('gives a view that draws nothing, takes no touch and stays in the dump', () => {
    const [view] = render(<LoupeProbe />)

    expect(view).toMatchObject({
      importantForAccessibility: 'no',
      collapsable: false,
      style: {
        position: 'absolute',
        top: 0,
        left: 0,
        width: 1,
        height: 1,
        pointerEvents: 'none',
      },
    })
    expect(view).not.toHaveProperty('accessible')
  })

  it('reports no insets, and does not throw, with no SafeAreaProvider', () => {
    const [view] = render(<LoupeProbe />)

    expect(reportOf(view)).not.toHaveProperty('insets')
  })

  it('reports the direction of the app', () => {
    native.isRTL = true

    expect(reportOf(render(<LoupeProbe />)[0])).toMatchObject({
      direction: 'rtl',
    })
  })

  it('leaves out the colour scheme when the system gives none', () => {
    native.colorScheme = null

    expect(reportOf(render(<LoupeProbe />)[0])).not.toHaveProperty(
      'colorScheme',
    )
  })

  it('renders nothing in a release build', () => {
    vi.stubGlobal('__DEV__', false)

    expect(render(<LoupeProbe route="/settings" />)).toEqual([])
  })
})
