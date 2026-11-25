import { describe, expect, it } from 'vitest'
import { type UiNode } from '../core/ui'
import {
  expoGoScreenOf,
  expoLink,
  hasAppContent,
  normalRoute,
  sdkWarning,
} from './expo-go'

const node = (fields: Partial<UiNode>): UiNode => ({
  type: 'android.widget.TextView',
  frame: { x: 0, y: 0, width: 100, height: 40 },
  ...fields,
})

describe('expoGoScreenOf', () => {
  it('needs the intro of the developer menu for the onboarding sheet', () => {
    expect(expoGoScreenOf([node({ text: 'Continue' })])).toBeUndefined()
    expect(
      expoGoScreenOf([
        node({
          text: 'This is the developer menu. It gives you access to useful tools in your development builds.',
        }),
        node({ children: [node({ text: 'Continue' })] }),
      ]),
    ).toBe('onboarding')
  })

  it('needs "Go home" and "Close" for the developer menu', () => {
    expect(expoGoScreenOf([node({ text: 'Go home' })])).toBeUndefined()
    expect(
      expoGoScreenOf([node({ text: 'Go home' }), node({ label: 'Close' })]),
    ).toBe('dev-menu')
  })

  it("finds the loading screen by Expo Go's progress bar", () => {
    expect(
      expoGoScreenOf([node({ id: 'host.exp.exponent:id/progressBar' })]),
    ).toBe('loading')
  })
})

describe('hasAppContent', () => {
  const layout = (children: UiNode[]): UiNode =>
    node({ type: 'android.widget.FrameLayout', children })

  it('finds text, a label or a touch deep in the tree', () => {
    expect(hasAppContent([layout([layout([node({ text: 'Hi' })])])])).toBe(true)
    expect(hasAppContent([layout([node({ label: 'Menu' })])])).toBe(true)
    expect(hasAppContent([layout([node({ clickable: true })])])).toBe(true)
  })

  it('finds none in layouts and a progress bar', () => {
    expect(
      hasAppContent([
        layout([
          node({
            type: 'android.widget.ProgressBar',
            id: 'host.exp.exponent:id/progressBar',
          }),
        ]),
      ]),
    ).toBe(false)
  })

  it("leaves out Expo Go's overlay and an element with no area", () => {
    expect(
      hasAppContent([
        layout([
          node({ type: 'c23', children: [node({ label: 'Tools' })] }),
          node({ text: 'Hidden', frame: { x: 0, y: 0, width: 0, height: 0 } }),
        ]),
      ]),
    ).toBe(false)
  })
})

describe('the route and the link', () => {
  it.each([
    ['settings', '/settings'],
    ['/settings/', '/settings'],
    ['/settings?tab=1', '/settings'],
    ['', '/'],
  ])('normalRoute(%j) is %j', (route, normal) => {
    expect(normalRoute(route)).toBe(normal)
  })

  it('opens the root with no path, and keeps the query of a route', () => {
    expect(expoLink(8081)).toBe('exp://127.0.0.1:8081')
    expect(expoLink(8081, '/')).toBe('exp://127.0.0.1:8081')
    expect(expoLink(19000, '/settings?tab=1')).toBe(
      'exp://127.0.0.1:19000/--/settings?tab=1',
    )
  })
})

describe('sdkWarning', () => {
  it('warns only when the major versions differ', () => {
    expect(sdkWarning('58.0.6', '58.0.0')).toBeUndefined()
    expect(sdkWarning(undefined, '58.0.0')).toBeUndefined()
    expect(sdkWarning('57.0.2', '58.0.0')).toContain('the Expo Go of SDK 58')
  })
})
