import { type RuleName } from '../../core/check'
import { LoupeError } from '../../core/errors'
import { type SweepDriver } from '../../core/sweep'
import { DEFAULT_WAIT_INTERVAL, notStill } from '../../core/wait'
import { checkAndroid } from './check'
import { type AndroidTarget } from './devices'
import { readAndroidDisplay, rotateAndroid } from './display'
import { openUrlAndroid } from './open-url'
import { captureAndroid } from './screenshot'
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
 * its own orientation gives `orientation_locked` for that screen.
 */
export function androidSweepDriver(
  target: AndroidTarget,
  app: string | undefined,
  rules: readonly RuleName[],
  { waitTimeout, rotateTimeout = 5000 }: SweepTiming,
): SweepDriver {
  return {
    look: async () => ({
      orientation: (await readAndroidDisplay(target)).orientation,
      theme: await readThemeAndroid(target),
    }),
    open: async (url) => {
      await openUrlAndroid(target, url, app)
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
    ],
  }
}
