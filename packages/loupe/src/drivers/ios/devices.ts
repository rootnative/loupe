import { type CommandContext } from '../../core/context'
import {
  type Device,
  type DeviceList,
  type DeviceState,
} from '../../core/device'
import { parseSimctlList, type SimulatorEntry } from './parse'
import { createSimctl } from './simctl'

function stateOf(state: string): { state: DeviceState; detail?: string } {
  switch (state) {
    case 'Booted':
      return { state: 'ready' }
    case 'Booting':
      return { state: 'booting' }
    case 'Shutdown':
      return { state: 'stopped' }
  }
  return { state: 'other', detail: state }
}

function deviceOf({ udid, name, state, os }: SimulatorEntry): Device {
  return {
    platform: 'ios',
    kind: 'simulator',
    udid,
    name,
    os,
    ...stateOf(state),
  }
}

/** True on a Mac: only there can iOS simulators run. */
export function hasSimulators(context: CommandContext): boolean {
  return context.hostPlatform === 'darwin'
}

/**
 * Lists the iOS simulators that Xcode can start: those that run first,
 * then the others in the order of simctl. It asks simctl only on a Mac.
 */
export async function listIosSimulators(
  context: CommandContext,
): Promise<DeviceList> {
  if (!hasSimulators(context)) return { devices: [], warnings: [] }
  const devices = parseSimctlList(
    await createSimctl(context).text(['list', '--json']),
  ).map(deviceOf)
  return {
    devices: [
      ...devices.filter((device) => device.state !== 'stopped'),
      ...devices.filter((device) => device.state === 'stopped'),
    ],
    warnings: [],
  }
}
