import { type CommandContext } from '../core/context'
import { LoupeError } from '../core/errors'
import { type RtlChange, type RtlMode, setRtl } from './app-config'
import { readExpoApp, untilManifestRtl } from './metro'

/** The folder of the app that Metro serves, and its dynamic config. */
export async function expoProject(
  context: CommandContext,
  port: number,
): Promise<{ projectRoot: string; dynamicConfigPath?: string }> {
  const app = await readExpoApp(context, port)
  if (!app.projectRoot) {
    throw new LoupeError(
      'unsupported',
      "The manifest of Metro gives no folder of the app, so loupe can't find app.json.",
    )
  }
  return {
    projectRoot: app.projectRoot,
    dynamicConfigPath: app.dynamicConfigPath,
  }
}

/**
 * Turns RTL on or off in the app.json of the app that Metro serves, and
 * waits until the manifest has the change. When the manifest doesn't get
 * it, app.json goes back as it was, and the error stays.
 */
export async function switchRtl(
  context: CommandContext,
  port: number,
  rtl: RtlMode,
  timeout?: number,
): Promise<RtlChange> {
  const { projectRoot, dynamicConfigPath } = await expoProject(context, port)
  const change = await setRtl(projectRoot, rtl, dynamicConfigPath)
  try {
    await untilManifestRtl(context, port, change.forces, timeout)
  } catch (error) {
    await change.undo()
    throw error
  }
  return change
}

/**
 * The direction that the app shows after the change: forcesRTL decides.
 * With supportsRTL alone, the device language does, so none.
 */
export function directionOf({
  forces,
  supports,
}: Pick<RtlChange, 'forces' | 'supports'>): 'ltr' | 'rtl' | undefined {
  if (forces) return 'rtl'
  return supports ? undefined : 'ltr'
}
