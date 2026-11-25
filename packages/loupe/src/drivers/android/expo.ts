import { setTimeout as sleep } from 'node:timers/promises'
import { findElement } from '../../core/element'
import { LoupeError, throwIfCancelled } from '../../core/errors'
import { type ProbeReport } from '../../core/probe'
import {
  CLOSE_BUTTON,
  EXPO_GO,
  type ExpoGoScreen,
  expoGoScreenOf,
  hasAppContent,
  normalRoute,
} from '../../expo/expo-go'
import { forceStopAndroid } from './app-switch'
import { type AndroidTarget } from './devices'
import { readWindowDisplay } from './display'
import { isAppWindow, readInFront } from './foreground'
import { type OpenedUrl, openUrlAndroid } from './open-url'
import { notRespondingPackage } from './parse'
import { tapAndroid } from './touch'
import { type AndroidUi, readAndroidUi } from './ui'
import { waitStillAndroid } from './wait'

// After a force-stop, the launcher stayed in front once after the link,
// and a second open 20 s later showed the app (round 10, API 35).
const OPEN_AGAIN_MS = 20_000
const READ_INTERVAL = 500

/** The version name of Expo Go on the device. With no Expo Go: `no_handler`. */
export async function readExpoGoVersion(
  target: AndroidTarget,
): Promise<string | undefined> {
  const installed = await target.adb.result(['shell', 'pm', 'path', EXPO_GO])
  if (
    installed.code !== 0 ||
    !installed.stdout.toString('utf8').includes('package:')
  ) {
    throw new LoupeError(
      'no_handler',
      `Expo Go isn't on ${target.serial}. Ask the user to install it: press "a" in "npx expo start", and the Expo CLI installs the Expo Go of the app's SDK.`,
    )
  }
  const dump = await target.adb.text(['shell', 'dumpsys', 'package', EXPO_GO])
  return /versionName=(\S+)/.exec(dump)?.[1]
}

/**
 * Stops Expo Go and the app in it, so the next open starts a new process,
 * and waits until its process is gone (`forceStopAndroid`).
 */
export function forceStopExpoGo(
  target: AndroidTarget,
  limit?: number,
): Promise<void> {
  return forceStopAndroid(target, EXPO_GO, limit)
}

/** Gives the port of Metro on this machine to the device: `adb reverse`. */
export async function reverseAndroid(
  target: AndroidTarget,
  port: number,
): Promise<void> {
  await target.adb.run(['reverse', `tcp:${port}`, `tcp:${port}`])
}

export interface ShownInExpoGo {
  opened: OpenedUrl
  /** How many times loupe opened the link. */
  opens: number
  /** What the last read saw before each time that loupe opened it again. */
  reopens: string[]
  /** The Expo Go sheets that loupe closed, in order. */
  closed: Exclude<ExpoGoScreen, 'loading'>[]
  /** From the first open until the app showed. */
  ms: number
  /** Left out when the app has no probe. */
  probe?: ProbeReport
}

interface ShowOptions {
  link: string
  /** The route to wait for when the app has the probe. */
  route?: string
  /** The direction to wait for when the app has the probe. */
  direction?: ProbeReport['direction']
  timeout: number
  /** How long after an open loupe opens the link again. */
  openAgain?: number
}

/** The tree of Expo Go, or undefined while uiautomator can't read it. */
async function readExpoGo(
  target: AndroidTarget,
): Promise<AndroidUi | 'not_idle' | undefined> {
  try {
    return await readAndroidUi(target, EXPO_GO)
  } catch (error) {
    if (error instanceof LoupeError && error.code === 'not_idle') {
      return 'not_idle'
    }
    if (error instanceof LoupeError && error.code === 'app_not_in_front') {
      return undefined
    }
    throw error
  }
}

/** The tree of a read, or none when uiautomator couldn't read it. */
const treeOf = (read: AndroidUi | 'not_idle' | undefined) =>
  typeof read === 'object' ? read : undefined

/**
 * The route that the app's probe shows now. Undefined with no probe, with
 * Expo Go not in front, and while the screen doesn't keep still.
 */
export async function probeRouteInExpoGo(
  target: AndroidTarget,
): Promise<string | undefined> {
  return treeOf(await readExpoGo(target))?.probe?.report?.route
}

/**
 * Opens the link in Expo Go and waits until the app shows. On the way it
 * closes Expo Go's onboarding sheet and developer menu, and opens the link
 * again when the app isn't there 20 s after an open. With the probe, the
 * app shows when the probe does, on the route. With no probe, it shows when
 * the screen has text, a label or a touch, keeps still, and a read after
 * that still finds no Expo Go screen. An "isn't responding" dialog
 * in front gives `app_not_in_front`, which points to `loupe dismiss`.
 */
export async function showInExpoGo(
  target: AndroidTarget,
  { link, route, direction, timeout, openAgain = OPEN_AGAIN_MS }: ShowOptions,
): Promise<ShownInExpoGo> {
  const start = Date.now()
  const opened = await openUrlAndroid(target, link, EXPO_GO)
  let opens = 1
  let openedAt = start
  const reopens: string[] = []
  const closed: ShownInExpoGo['closed'] = []
  let last = 'nothing yet'
  // True while the last read found Expo Go's screen moving all the time.
  let notIdle = false

  while (Date.now() - start < timeout) {
    throwIfCancelled(target.signal)
    const { focus } = await readWindowDisplay(target)
    const inExperience =
      isAppWindow(focus, EXPO_GO) && !focus?.includes('LauncherActivity')
    let appShows = false

    if (!inExperience) {
      notIdle = false
      // Throws `app_not_in_front` with the advice to run `loupe dismiss`.
      if (notRespondingPackage(focus) !== undefined) {
        await readInFront(target, EXPO_GO)
      }
      last = isAppWindow(focus, EXPO_GO)
        ? "Expo Go's home screen"
        : target.kind === 'device'
          ? 'another window in front'
          : `${focus ?? 'no window'} in front`
    } else {
      const read = await readExpoGo(target)
      notIdle = read === 'not_idle'
      const ui = treeOf(read)
      const screen = ui && expoGoScreenOf(ui.nodes)
      if (!ui) {
        last = "Expo Go's screen, which didn't keep still for uiautomator"
      } else if (screen === 'onboarding' || screen === 'dev-menu') {
        const { point } = findElement(
          ui.nodes,
          CLOSE_BUTTON[screen],
          ui.display.size,
        )
        await tapAndroid(target, point, EXPO_GO)
        closed.push(screen)
        last = `Expo Go's ${screen === 'onboarding' ? 'onboarding sheet' : 'developer menu'}`
      } else if (screen === 'loading') {
        last = "Expo Go's loading screen"
      } else if (!ui.probe?.report && !hasAppContent(ui.nodes)) {
        last = 'a screen with no text, label or touch yet'
      } else if (!ui.probe?.report) {
        appShows = true
        const remaining = Math.max(0, timeout - (Date.now() - start))
        if (await stillAppInExpoGo(target, remaining)) {
          return { opened, opens, reopens, closed, ms: Date.now() - start }
        }
        last = 'the app with no probe, then another screen'
      } else {
        const probe = ui.probe.report
        appShows = true
        const onRoute =
          route === undefined ||
          probe.route === undefined ||
          normalRoute(probe.route) === normalRoute(route)
        const inDirection =
          direction === undefined || probe.direction === direction
        if (onRoute && inDirection) {
          return {
            opened,
            opens,
            reopens,
            closed,
            ms: Date.now() - start,
            probe,
          }
        }
        last = onRoute
          ? `the app in ${probe.direction}`
          : `the app on ${probe.route}`
      }
    }

    // A link can get lost while Expo Go starts: open it once more.
    const stuck = !inExperience || appShows
    if (stuck && Date.now() - openedAt >= openAgain) {
      await openUrlAndroid(target, link, EXPO_GO)
      opens += 1
      reopens.push(last)
      openedAt = Date.now()
    }
    await sleep(READ_INTERVAL)
  }

  if (notIdle) {
    throw new LoupeError(
      'not_idle',
      `Expo Go shows a screen after loupe opened ${link}, but it didn't keep still in ${Math.round(timeout / 1000)} s, so uiautomator can't read it. An animation that never stops, or a long one, can cause this. Take a screenshot to see the screen, wait until the animation ends, or open a route with no such animation.`,
    )
  }
  throw new LoupeError(
    'timeout',
    `Expo Go didn't show the app in ${Math.round(timeout / 1000)} s after loupe opened ${link} (${opens === 1 ? 'once' : `${opens} times`}). The last read: ${last}.`,
  )
}

/**
 * With no probe: true when the screen keeps still within `timeout`, and a
 * read after that still finds the app, not an Expo Go screen. The
 * onboarding sheet can come a moment after the app (CI 45599663119).
 */
async function stillAppInExpoGo(
  target: AndroidTarget,
  timeout: number,
): Promise<boolean> {
  await waitStillInExpoGo(target, timeout)
  const again = treeOf(await readExpoGo(target))
  return (
    again !== undefined &&
    expoGoScreenOf(again.nodes) === undefined &&
    !again.probe?.report &&
    hasAppContent(again.nodes)
  )
}

/** Waits until the screen keeps still, within `timeout`. */
async function waitStillInExpoGo(
  target: AndroidTarget,
  timeout: number,
): Promise<void> {
  const still = await waitStillAndroid(target, EXPO_GO, {
    timeout,
    interval: READ_INTERVAL,
  })
  if (!still.still) {
    throw new LoupeError(
      'timeout',
      `The app shows in Expo Go, but its screen didn't keep still in ${Math.round(timeout / 1000)} s.`,
    )
  }
}
