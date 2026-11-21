import { setTimeout as sleep } from 'node:timers/promises'
import { LoupeError } from '../../core/errors'
import { type AndroidTarget } from './devices'
import { readWindowDisplay } from './display'
import { isAppWindow, notRespondingAdvice, readInFront } from './foreground'
import { parseRecentTasks, type RecentTask } from './parse'

/**
 * The ways back to the front, in the order loupe tries them. `recents`: the
 * Recents key two times, as a person does; it needs the home screen in
 * front and the app's task the most recent. `task-lock`: `am task lock` on
 * the app's task, then `lock stop`; it needs no launcher, but Android shows
 * an "App unpinned" toast for a few seconds.
 */
export const WAYS_BACK = ['recents', 'task-lock'] as const

export type WayBack = (typeof WAYS_BACK)[number]

export interface Back {
  /** `in-front` when the app was in front already. */
  way: WayBack | 'in-front'
  /** Each way that loupe tried, in order. */
  tried: WayBack[]
  /** The task that came back. */
  task?: number
  /** Milliseconds from the first key or command until the app had the focus. */
  ms: number
}

export interface SwitchTiming {
  /** Milliseconds between the two Recents keys. Default: 1500. */
  recentsPause?: number
  /** Milliseconds to wait for a window to have the focus. Default: 5000. */
  limit?: number
  /** Milliseconds between two reads of the focus. Default: 250. */
  interval?: number
}

const DEFAULTS = { recentsPause: 1500, limit: 5000, interval: 250 }

/** The package of a window title, `package/activity` or `package`. */
function packageOf(title: string | undefined): string | undefined {
  return title?.split('/')[0]
}

async function recentTasks(target: AndroidTarget): Promise<RecentTask[]> {
  return parseRecentTasks(
    await target.adb.text(['shell', 'dumpsys', 'activity', 'recents']),
  )
}

/** Reads the focus until `done` gives true, for up to `limit` ms. */
async function focusUntil(
  target: AndroidTarget,
  done: (focus: string | undefined) => boolean,
  { limit, interval }: Required<SwitchTiming>,
): Promise<boolean> {
  const start = Date.now()
  for (;;) {
    if (done((await readWindowDisplay(target)).focus)) return true
    if (Date.now() - start >= limit) return false
    await sleep(interval)
  }
}

function key(target: AndroidTarget, code: string): Promise<unknown> {
  return target.adb.run(['shell', 'input', 'keyevent', code])
}

/**
 * True when a real device asks for the lock screen to end a task lock: then
 * `lock stop` can lock the phone, so loupe doesn't lock a task there.
 */
async function lockLocksPhone(target: AndroidTarget): Promise<boolean> {
  if (target.kind !== 'device') return false
  const setting = await target.adb.text([
    'shell',
    'settings',
    'get',
    'secure',
    'lock_to_app_exit_locked',
  ])
  return setting.trim() === '1'
}

/**
 * Brings the most recent task of `app` to the front: with the Recents key
 * when the home screen is in front and the app's task is the most recent
 * after it, else (or when the app isn't back after the keys) with a task
 * lock. Fails with `app_not_in_front` when the app has no task, or neither
 * way brings it back.
 */
export async function foregroundAndroid(
  target: AndroidTarget,
  app: string,
  timing: SwitchTiming = {},
): Promise<Back> {
  const options = { ...DEFAULTS, ...timing }
  const focus = (await readWindowDisplay(target)).focus
  if (isAppWindow(focus, app)) return { way: 'in-front', tried: [], ms: 0 }

  const tasks = await recentTasks(target)
  const task = tasks.find(
    (candidate) => candidate.type !== 'home' && candidate.package === app,
  )
  if (!task) {
    throw new LoupeError(
      'app_not_in_front',
      `${app} has no task in the recent tasks of ${target.serial}, so loupe can't bring it back. Open it first.`,
    )
  }

  const tried: WayBack[] = []
  const start = Date.now()
  const [front, next] = tasks
  const homeInFront =
    front?.type === 'home' &&
    front.package !== undefined &&
    isAppWindow(focus, front.package)
  if (homeInFront && next?.id === task.id) {
    tried.push('recents')
    await key(target, 'KEYCODE_APP_SWITCH')
    await sleep(options.recentsPause)
    await key(target, 'KEYCODE_APP_SWITCH')
    if (await focusUntil(target, (now) => isAppWindow(now, app), options)) {
      return { way: 'recents', tried, task: task.id, ms: Date.now() - start }
    }
  }

  if (await lockLocksPhone(target)) {
    throw new LoupeError(
      'app_not_in_front',
      `${app} isn't back in front, and loupe doesn't lock its task on ${target.serial}: this phone asks for the lock screen to end a task lock. Open ${app}, then try again.`,
    )
  }
  tried.push('task-lock')
  await target.adb.run(['shell', 'am', 'task', 'lock', String(task.id)])
  const back = await focusUntil(target, (now) => isAppWindow(now, app), options)
  await target.adb.run(['shell', 'am', 'task', 'lock', 'stop'])
  if (!back) {
    const { focus: now } = await readWindowDisplay(target)
    throw new LoupeError(
      'app_not_in_front',
      `${app} isn't back in front after ${tried.join(' and ')} on ${target.serial}.${notRespondingAdvice(target, now, app)}`,
    )
  }
  return { way: 'task-lock', tried, task: task.id, ms: Date.now() - start }
}

export interface Background {
  app: string
  /** Milliseconds from HOME to the first step back. Left out with no `for`. */
  away?: number
  back?: Back
}

/**
 * Sends the app in front to the background with HOME. With `forMs`, waits,
 * then brings it back (`foregroundAndroid`). Without `app`, the app is the
 * package of the window in front (an emulator only: a real device needs
 * `app`).
 */
export async function backgroundAndroid(
  target: AndroidTarget,
  app: string | undefined,
  forMs?: number,
  timing: SwitchTiming = {},
): Promise<Background> {
  const options = { ...DEFAULTS, ...timing }
  const { focus } = await readInFront(target, app)
  const inFront = app ?? packageOf(focus)
  const [front] = await recentTasks(target)
  if (!inFront || (front?.type === 'home' && front.package === inFront)) {
    // On a real device, the name of the window is the user's data.
    const where =
      focus && target.kind !== 'device' ? ` (the focus is on ${focus})` : ''
    throw new LoupeError(
      'app_not_in_front',
      `No app is in front of ${target.serial}${where}, so loupe sends none to the background. Open the app, then try again.`,
    )
  }

  await key(target, 'KEYCODE_HOME')
  const left = Date.now()
  const gone = await focusUntil(
    target,
    (now) => now !== undefined && !isAppWindow(now, inFront),
    options,
  )
  if (!gone) {
    throw new LoupeError(
      'timeout',
      `${inFront} is still in front ${options.limit} ms after HOME.`,
    )
  }
  if (forMs === undefined) return { app: inFront }

  await sleep(Math.max(0, forMs - (Date.now() - left)))
  const away = Date.now() - left
  const back = await foregroundAndroid(target, inFront, timing)
  return { app: inFront, away, back }
}
