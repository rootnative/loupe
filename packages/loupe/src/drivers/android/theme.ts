import { setTimeout as sleep } from 'node:timers/promises'
import { LoupeError } from '../../core/errors'
import { DEFAULT_WAIT_INTERVAL } from '../../core/wait'
import { type AndroidTarget } from './devices'
import { readInFront } from './foreground'
import { parseNightMode } from './parse'
import { readAndroidUi } from './ui'

export const THEMES = ['light', 'dark'] as const

export type Theme = (typeof THEMES)[number]

/**
 * The system setting: a theme, or `auto` (Android picks one by the time of
 * day), or `custom` (by a schedule).
 */
export const THEME_SETTINGS = [...THEMES, 'auto', 'custom'] as const

export type ThemeSetting = (typeof THEME_SETTINGS)[number]

export interface ThemeChange {
  theme: Theme
  was: ThemeSetting
  /**
   * What showed the theme: the probe's colour scheme on the screen, or the
   * setting alone (no probe, or a probe that kept the other scheme).
   */
  source: 'probe' | 'setting'
  /** Milliseconds from the write until the source showed the theme. */
  ms: number
  warnings: string[]
}

export interface ThemeTiming {
  /** Milliseconds to wait for the probe to show the theme. Default: 5000. */
  timeout?: number
  /** Milliseconds between two reads. Default: 250. */
  interval?: number
}

const NIGHT: Record<Theme, string> = { light: 'no', dark: 'yes' }

function settingOf(target: AndroidTarget, text: string): ThemeSetting {
  const mode = parseNightMode(text)
  switch (mode) {
    case 'no':
      return 'light'
    case 'yes':
      return 'dark'
    case 'auto':
    case 'custom':
      return mode
    default:
      throw new LoupeError(
        'tool_failed',
        `loupe can't read the night mode of ${target.serial} from "cmd uimode night".`,
      )
  }
}

function night(target: AndroidTarget, value?: string): Promise<string> {
  const args = ['shell', 'cmd', 'uimode', 'night']
  return target.adb.text(value ? [...args, value] : args)
}

/** The system theme setting, from `cmd uimode night`. */
export async function readThemeAndroid(
  target: AndroidTarget,
): Promise<ThemeSetting> {
  return settingOf(target, await night(target))
}

// The app can be busy while it draws the new theme, and a dialog of another
// app can cover it for a moment.
const PASSING_CODES = new Set(['not_idle', 'app_not_in_front'])

/**
 * The colour scheme of the probe on the screen, read until it is `theme`
 * or the time is up. Undefined when the screen has no probe, or the probe
 * reports no scheme.
 */
async function probeScheme(
  target: AndroidTarget,
  app: string | undefined,
  theme: Theme,
  { timeout, interval }: Required<ThemeTiming>,
): Promise<Theme | undefined> {
  const start = Date.now()
  for (;;) {
    let scheme: Theme | undefined
    let failure: LoupeError | undefined
    try {
      scheme = (await readAndroidUi(target, app)).probe?.report?.colorScheme
      if (scheme === undefined || scheme === theme) return scheme
    } catch (error) {
      if (!(error instanceof LoupeError && PASSING_CODES.has(error.code))) {
        throw error
      }
      failure = error
    }
    if (Date.now() - start >= timeout) {
      if (!failure) return scheme
      throw new LoupeError(
        failure.code,
        `The theme is ${theme} now, but loupe can't see the app show it. ${failure.message}`,
      )
    }
    await sleep(interval)
  }
}

/**
 * Sets the system theme with `cmd uimode night`, and reads the setting back
 * from its output. Then, when the screen has the probe, waits until the
 * probe shows the theme: the app has drawn it then. An app that keeps one
 * theme (for example `userInterfaceStyle` in Expo) never shows the other,
 * so that gives a warning, not an error. The setting stays after loupe
 * exits. A real device needs `app`.
 */
export async function setThemeAndroid(
  target: AndroidTarget,
  theme: Theme,
  app: string | undefined,
  { timeout = 5000, interval = DEFAULT_WAIT_INTERVAL }: ThemeTiming = {},
): Promise<ThemeChange> {
  await readInFront(target, app)
  const was = await readThemeAndroid(target)
  const start = Date.now()
  if (was !== theme) {
    const now = settingOf(target, await night(target, NIGHT[theme]))
    if (now !== theme) {
      throw new LoupeError(
        'tool_failed',
        `Android kept the theme ${now} on ${target.serial}, not ${theme}.`,
      )
    }
  }

  const scheme = await probeScheme(target, app, theme, { timeout, interval })
  const ms = Date.now() - start
  if (scheme === undefined || scheme === theme) {
    return {
      theme,
      was,
      source: scheme ? 'probe' : 'setting',
      ms,
      warnings: [],
    }
  }
  return {
    theme,
    was,
    source: 'setting',
    ms,
    warnings: [
      `The setting is ${theme}, but the probe still shows ${scheme} after ${timeout} ms. The app can keep one theme (for example userInterfaceStyle in Expo), or it is slow.`,
    ],
  }
}
