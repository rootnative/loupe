import { z } from 'zod'
import { defineCommand } from '../core/command'
import { type Device, deviceSchema } from '../core/device'
import { listDevices } from '../drivers/devices'

const HEADER = ['Id', 'State', 'Kind', 'Name', 'OS']

const idOf = (device: Device): string | undefined =>
  device.serial ?? device.udid

function row(device: Device): string[] {
  return [
    idOf(device) ?? '-',
    device.state,
    device.kind,
    device.avd ?? device.name ?? device.model ?? '',
    device.apiLevel === undefined
      ? (device.os ?? '')
      : `API ${device.apiLevel}`,
  ]
}

function table(rows: readonly string[][]): string[] {
  const widths = HEADER.map((_, column) =>
    Math.max(...rows.map((cells) => cells[column]?.length ?? 0)),
  )
  return rows.map((cells) =>
    cells
      .map((cell, column) => cell.padEnd(widths[column] ?? 0))
      .join('  ')
      .trimEnd(),
  )
}

export const devicesCommand = defineCommand({
  name: 'devices',
  summary:
    "List the Android emulators and devices, the iOS simulators, and the AVDs that don't run",
  readOnly: true,
  input: z.object({}),
  output: z.object({
    devices: z.array(deviceSchema),
    warnings: z.array(z.string()),
  }),
  run: (_input, context) => listDevices(context),
  format: ({ devices, warnings }) => {
    const lines =
      devices.length > 0
        ? table([HEADER, ...devices.map(row)])
        : ['No devices, no AVDs, and no simulators.']
    const details = devices
      .filter((device) => device.detail)
      .map((device) => `${idOf(device)}: ${device.detail}`)
    return [
      ...lines,
      ...details,
      ...warnings.map((warning) => `Warning: ${warning}`),
    ].join('\n')
  },
})
