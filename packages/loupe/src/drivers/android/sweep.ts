import { type RuleName } from '../../core/check'
import { type CommandContext } from '../../core/context'
import { LoupeError } from '../../core/errors'
import { type SweepDirection, type SweepDriver } from '../../core/sweep'
import { DEFAULT_WAIT_INTERVAL, notStill } from '../../core/wait'
import { EXPO_GO, routeOfLink } from '../../expo/expo-go'
import { directionOf, switchRtl } from '../../expo/rtl'
import { forceStopAndroid } from './app-switch'
import { checkAndroid } from './check'
import { type AndroidTarget } from './devices'
import { readAndroidDisplay, rotateAndroid } from './display'
import { showInExpoGo } from './expo'
import { openUrlAndroid } from './open-url'
import { captureAndroid } from './screenshot'
import { flingToTopAndroid, scrollOnceAndroid } from './scroll'
import {
  readThemeAndroid,
  restoreThemeAndroid,
  setThemeAndroid,
  type ThemeSetting,
} from './theme'
import { waitStillAndroid } from './wait'

export interface SweepTiming {
  /** Milliseconds to wait for each screen to keep still. */
  waitTimeout: number
  /** Milliseconds to wait for the screen to turn. Default: 5000. */
  rotateTimeout?: number
  /** Milliseconds for Expo Go to show the app after a restart. Default: 120000. */
  coldTimeout?: number
}

/** The Metro of the app in Expo Go, for a sweep with directions. */
export interface SweepMetro {
  context: CommandContext
  port: number
}

/** The message of a failed restore, as a warning. */
async function orWarning(restore: () => Promise<unknown>): Promise<string[]> {
  try {
    await restore()
    return []
  } catch (error) {
    if (!(error instanceof LoupeError)) throw error
    return [error.message]
  }
}

/**
 * The sweep on an Android device. It turns the screen and sets the theme
 * only when they differ, with the app's screen open, so an app that sets
 * its own orientation gives `orientation_locked` for that screen. With
 * `metro`, it sets the direction of the app in Expo Go as `expo-rtl` does.
 */
export function androidSweepDriver(
  target: AndroidTarget,
  app: string | undefined,
  rules: readonly RuleName[],
  { waitTimeout, rotateTimeout = 5000, coldTimeout = 120_000 }: SweepTiming,
  metro?: SweepMetro,
): SweepDriver {
  let lastUrl: string | undefined

  /** Opens the link in a stopped Expo Go, and waits for the app. */
  const openCold = (url: string, direction?: SweepDirection) =>
    showInExpoGo(target, {
      link: url,
      route: routeOfLink(url),
      direction,
      timeout: coldTimeout,
    })

  const needMetro = (): SweepMetro => {
    if (!metro || app !== EXPO_GO) {
      throw new LoupeError(
        'invalid_input',
        'A sweep with direction needs the app in Expo Go: app host.exp.exponent.',
      )
    }
    return metro
  }

  return {
    look: async () => ({
      orientation: (await readAndroidDisplay(target)).orientation,
      theme: await readThemeAndroid(target),
    }),
    open: async (url, { cold, direction }) => {
      lastUrl = url
      // A cold Expo Go shows its loading screen, can lose the link, and the
      // app can show its first route before the one of the link.
      if (cold && app === EXPO_GO) {
        await openCold(url, direction)
        return
      }
      await openUrlAndroid(target, url, app)
    },
    setDirection: async (direction) => {
      const { context, port } = needMetro()
      const change = await switchRtl(
        context,
        port,
        direction === 'rtl' ? 'on' : 'off',
      )
      if (!change.changed) return { restarted: false }
      await forceStopAndroid(target, EXPO_GO)
      return { restarted: true }
    },
    reload: async () => {
      if (!app) {
        throw new LoupeError(
          'invalid_input',
          'A sweep with reloadEvery needs app: the package that loupe stops.',
        )
      }
      await forceStopAndroid(target, app)
    },
    rotate: async (orientation) => {
      if ((await readAndroidDisplay(target)).orientation === orientation) return
      await rotateAndroid(target, orientation, { timeout: rotateTimeout })
    },
    setTheme: async (theme) => {
      if ((await readThemeAndroid(target)) === theme) return []
      return (await setThemeAndroid(target, theme, app)).warnings
    },
    waitStill: async () => {
      const still = await waitStillAndroid(target, app, {
        timeout: waitTimeout,
        interval: DEFAULT_WAIT_INTERVAL,
      })
      if (!still.still) {
        throw new LoupeError(
          'timeout',
          `The link opened, but ${notStill(still)}`,
        )
      }
    },
    check: async () => {
      const { check, png } = await checkAndroid(target, app, rules, {}, true)
      if (!png)
        throw new LoupeError('internal', 'The check took no screenshot.')
      return { check, png }
    },
    capture: async () => (await captureAndroid(target, app)).png,
    scroll: async () => {
      const scrolled = await scrollOnceAndroid(target, app)
      return (
        scrolled && { back: () => flingToTopAndroid(target, scrolled, app) }
      )
    },
    restore: async (look, changed) => [
      ...(changed.orientation
        ? await orWarning(async () => {
            const now = (await readAndroidDisplay(target)).orientation
            if (now !== look.orientation) {
              await rotateAndroid(target, look.orientation, {
                timeout: rotateTimeout,
              })
            }
          })
        : []),
      ...(changed.theme
        ? await orWarning(() =>
            restoreThemeAndroid(target, look.theme as ThemeSetting),
          )
        : []),
      // app.json goes back as it was, and the app opens its last link again
      // in that direction.
      ...(changed.direction && metro
        ? await orWarning(async () => {
            const change = await switchRtl(metro.context, metro.port, 'off')
            if (!change.changed) return
            await forceStopAndroid(target, EXPO_GO)
            if (lastUrl) await openCold(lastUrl, directionOf(change))
          })
        : []),
    ],
  }
}
