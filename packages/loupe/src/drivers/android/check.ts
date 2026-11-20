import {
  type CheckOptions,
  RULE_CHECKS,
  type RuleName,
  type ScreenCheck,
} from '../../core/check'
import { LoupeError } from '../../core/errors'
import { type Image } from '../../core/png'
import { decodeCapture } from '../../core/screenshot'
import { type AndroidTarget } from './devices'
import { insetsOfUi } from './insets'
import { captureAndroid } from './screenshot'
import { type AndroidUi, readAndroidUi } from './ui'

export interface CheckedAndroid {
  check: ScreenCheck
  ui: AndroidUi
  /** The screenshot of the checked screen, when one was taken. */
  png?: Buffer
}

/**
 * Runs the rules on a screen that `readAndroidUi` gave: the insets, then a
 * screenshot when the `centred` rule runs or `shot` asks for one. The
 * screenshot must have the size of the tree's screen, else `not_idle`.
 */
export async function checkAndroidUi(
  target: AndroidTarget,
  app: string | undefined,
  ui: AndroidUi,
  names: readonly RuleName[],
  options: CheckOptions = {},
  shot = false,
): Promise<CheckedAndroid> {
  const insets = await insetsOfUi(target, ui)
  let png: Buffer | undefined
  let image: Image | undefined
  if (shot || names.includes('centred')) {
    png = (await captureAndroid(target, app)).png
    image = decodeCapture(png)
    const { pixels } = ui.display
    if (image.width !== pixels.width || image.height !== pixels.height) {
      throw new LoupeError(
        'not_idle',
        `The screen turned between the tree and the screenshot (${pixels.width} × ${pixels.height} px, then ${image.width} × ${image.height} px). Wait until it's still, then try again.`,
      )
    }
  }
  const screen = {
    display: ui.display,
    app: ui.app,
    nodes: ui.nodes,
    direction: ui.probe?.report?.direction,
    insets,
    image,
  }
  const results = names.map((name) => RULE_CHECKS[name](screen, options))
  return {
    check: {
      ...ui.display,
      app: ui.app,
      safeAreaSource: insets.source,
      passed: results.every((result) => result.passed),
      results,
      warnings: insets.warnings,
    },
    ui,
    png,
  }
}

/** Reads the screen while `app` is in front, and runs the rules on it. */
export async function checkAndroid(
  target: AndroidTarget,
  app: string | undefined,
  names: readonly RuleName[],
  options: CheckOptions = {},
  shot = false,
): Promise<CheckedAndroid> {
  const ui = await readAndroidUi(target, app)
  return checkAndroidUi(target, app, ui, names, options, shot)
}
