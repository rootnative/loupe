import { z } from 'zod'
import { defineCommand } from '../core/command'
import { appField, deviceField } from '../core/device'
import { waitedSchema, waitFields, withWaited } from '../core/wait'
import { selectAndroidOnly } from '../drivers/select'
import {
  readThemeAndroid,
  setThemeAndroid,
  THEME_SETTINGS,
  THEMES,
  type ThemeSetting,
} from '../drivers/android/theme'
import { waitAfterAction } from '../drivers/android/wait'

const settingSchema = z
  .enum(THEME_SETTINGS)
  .describe(
    'light or dark; auto: Android picks one by the time of day; custom: by a schedule.',
  )

function describeSetting(setting: ThemeSetting): string {
  switch (setting) {
    case 'auto':
      return 'auto: Android picks light or dark by the time of day'
    case 'custom':
      return 'custom: Android picks light or dark by a schedule'
    default:
      return setting
  }
}

export const themeCommand = defineCommand({
  name: 'theme',
  summary:
    'Set the system theme to light or dark, and wait until the app shows it. With no theme, read it',
  input: z.object({
    theme: z
      .enum(THEMES)
      .optional()
      .describe('light or dark. Left out: loupe only reads the setting.'),
    timeout: z
      .number()
      .int()
      .min(0)
      .default(5000)
      .describe(
        "Milliseconds to wait until the app's probe shows the theme. A screen with no probe has no wait.",
      ),
    ...waitFields,
    app: appField,
    device: deviceField,
  }),
  positionals: ['theme'],
  output: z.object({
    theme: settingSchema.describe('The system theme setting now.'),
    was: settingSchema
      .optional()
      .describe('The setting before. Left out when loupe only read it.'),
    source: z
      .enum(['probe', 'setting'])
      .optional()
      .describe(
        "What showed the theme: probe, the app's probe on the screen; setting, the system setting alone (no probe on the screen, or a probe that kept the other scheme).",
      ),
    ms: z
      .number()
      .optional()
      .describe('Milliseconds from the write until the source showed it.'),
    warnings: z.array(z.string()),
    waited: waitedSchema.optional(),
  }),
  run: async ({ theme, timeout, app, device, ...wait }, context) => {
    const target = await selectAndroidOnly(context, device)
    if (!theme) return { theme: await readThemeAndroid(target), warnings: [] }

    const change = await setThemeAndroid(target, theme, app, { timeout })
    const waited = await waitAfterAction(target, app, wait, 'theme')
    return { ...change, waited }
  },
  format: ({ theme, was, source, ms, warnings, waited }) => {
    let summary = `The theme is ${describeSetting(theme)}.`
    if (was !== undefined) {
      const set =
        was === theme
          ? `The theme is ${theme} already`
          : `Set the theme to ${theme} (it was ${was})`
      summary =
        source === 'probe'
          ? `${set}. The app's probe shows it after ${ms} ms.`
          : warnings.length > 0
            ? `${set}. Only the setting shows it.`
            : `${set}. Only the setting shows it: the screen has no probe.`
    }
    return [
      withWaited(summary, waited),
      ...warnings.map((warning) => `Warning: ${warning}`),
    ].join('\n')
  },
})
