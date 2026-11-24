import { type Selector } from '../core/element'
import { type UiNode } from '../core/ui'

/** The package of Expo Go on Android. */
export const EXPO_GO = 'host.exp.exponent'

/** A screen of Expo Go that hides the app. */
export type ExpoGoScreen = 'onboarding' | 'dev-menu' | 'loading'

/** The button that closes each Expo Go sheet, as an agent taps it. */
export const CLOSE_BUTTON: Readonly<
  Record<Exclude<ExpoGoScreen, 'loading'>, Selector>
> = {
  onboarding: { by: 'text', value: 'Continue' },
  'dev-menu': { by: 'label', value: 'Close' },
}

function* eachNode(nodes: readonly UiNode[]): Generator<UiNode> {
  for (const node of nodes) {
    yield node
    yield* eachNode(node.children ?? [])
  }
}

/**
 * The Expo Go screen in a tree (round 10): the onboarding sheet of the first
 * open ("Continue" under the intro of the developer menu), the developer
 * menu ("Go home" and "Close"), or the loading screen (Expo Go's progress
 * bar). While one shows, the tree has none of the app.
 */
export function expoGoScreenOf(
  nodes: readonly UiNode[],
): ExpoGoScreen | undefined {
  const all = [...eachNode(nodes)]
  const has = (test: (node: UiNode) => boolean) => all.some(test)
  if (
    has((node) => node.text === 'Continue') &&
    has((node) => node.text?.startsWith('This is the developer menu') === true)
  ) {
    return 'onboarding'
  }
  if (
    has((node) => node.text === 'Go home') &&
    has((node) => node.label === 'Close')
  ) {
    return 'dev-menu'
  }
  if (has((node) => node.id === 'host.exp.exponent:id/progressBar')) {
    return 'loading'
  }
  return undefined
}

/** A route as the probe gives it: `settings/` and `/settings?tab=1` give `/settings`. */
export function normalRoute(route: string): string {
  const path = route.split(/[?#]/)[0] ?? ''
  return `/${path.replace(/^\/+|\/+$/g, '')}`
}

/**
 * The link that opens the app in Expo Go on 127.0.0.1, through `adb
 * reverse` of the port: `exp://127.0.0.1:8081/--/settings` for `settings`.
 */
export function expoLink(port: number, route = '/'): string {
  const path = route.replace(/^\/+/, '')
  return path ? `exp://127.0.0.1:${port}/--/${path}` : `exp://127.0.0.1:${port}`
}

const majorOf = (version: string): string => version.split('.')[0] ?? ''

/**
 * A warning when Expo Go isn't for the SDK of the app. Expo Go runs one
 * SDK, and shows an error for an app on another one.
 */
export function sdkWarning(
  expoGo: string | undefined,
  sdk: string | undefined,
): string | undefined {
  if (!expoGo || !sdk || majorOf(expoGo) === majorOf(sdk)) return undefined
  return `Expo Go ${expoGo} is for SDK ${majorOf(expoGo)}, and the app is on SDK ${sdk}, so Expo Go shows an error, not the app. Ask the user to install the Expo Go of SDK ${majorOf(sdk)}: press "a" in "npx expo start".`
}
