import { LoupeError } from '../../core/errors'
import { shellQuote } from './adb'
import { type AndroidTarget } from './devices'
import { parseAmStart } from './parse'

export interface OpenedUrl {
  url: string
  /** `package/activity` */
  activity?: string
  /** `cold`, `warm` or `hot`. */
  launchState?: string
  /** Milliseconds, as Android measured the start. */
  totalTime?: number
}

/**
 * Opens a link with `am start -W`, which waits until the activity has
 * started. With `app`, only that app can open the link. A real device needs
 * `app`, so a link can't open one of the user's other apps.
 */
export async function openUrlAndroid(
  target: AndroidTarget,
  url: string,
  app?: string,
): Promise<OpenedUrl> {
  if (!app && target.kind === 'device') {
    throw new LoupeError(
      'invalid_input',
      `${target.serial} is a real device, so loupe needs the "app" option: the package of the app under test. Then only that app opens the link.`,
    )
  }

  const result = await target.adb.result([
    'shell',
    'am',
    'start',
    '-W',
    '-a',
    'android.intent.action.VIEW',
    '-d',
    shellQuote(url),
    ...(app ? ['-p', app] : []),
  ])
  const start = parseAmStart(
    `${result.stdout.toString('utf8')}\n${result.stderr.toString('utf8')}`,
  )

  if (start.unresolved) {
    throw new LoupeError(
      'no_handler',
      app
        ? `${app} doesn't open ${url} on ${target.serial}.`
        : `No app on ${target.serial} opens ${url}.`,
    )
  }
  if (start.status !== 'ok') {
    throw new LoupeError(
      'tool_failed',
      start.error
        ? `am start failed on ${target.serial}: ${start.error}`
        : `am start failed on ${target.serial} with exit code ${result.code}.`,
    )
  }
  return {
    url,
    activity: start.activity,
    launchState: start.launchState?.toLowerCase(),
    totalTime: start.totalTime,
  }
}
