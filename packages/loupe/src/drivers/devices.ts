import { type CommandContext } from '../core/context'
import { type DeviceList } from '../core/device'
import { LoupeError } from '../core/errors'
import { listAndroidDevices } from './android/devices'
import { hasSimulators, listIosSimulators } from './ios/devices'

type Listed = { list: DeviceList } | { error: LoupeError }

async function attempt(promise: Promise<DeviceList>): Promise<Listed> {
  try {
    return { list: await promise }
  } catch (error) {
    if (error instanceof LoupeError) return { error }
    throw error
  }
}

/**
 * Lists the Android devices, then on a Mac the iOS simulators. On a Mac, a
 * platform whose tools fail gives a warning in place of its devices, so a
 * Mac with only Xcode, or with only the Android SDK, still gets its list.
 * When no platform gives a list, the error of Android is the error.
 */
export async function listDevices(
  context: CommandContext,
): Promise<DeviceList> {
  if (!hasSimulators(context)) return listAndroidDevices(context)

  const [android, ios] = await Promise.all([
    attempt(listAndroidDevices(context)),
    attempt(listIosSimulators(context)),
  ])
  if ('error' in android && 'error' in ios) throw android.error

  const lists = [android, ios].map((listed, index): DeviceList =>
    'list' in listed
      ? listed.list
      : {
          devices: [],
          warnings: [
            `The list has no ${index === 0 ? 'Android devices' : 'iOS simulators'}. ${listed.error.message}`,
          ],
        },
  )
  return {
    devices: lists.flatMap((list) => list.devices),
    warnings: lists.flatMap((list) => list.warnings),
  }
}
