import { z } from 'zod'
import { defineCommand } from '../core/command'
import { type Device, deviceSchema } from '../core/device'
import { listAndroidDevices } from '../drivers/android/devices'

const HEADER = ['Serial', 'State', 'Kind', 'Name', 'API']

function row(device: Device): string[] {
  return [
    device.serial ?? '-',
    device.state,
    device.kind,
    device.avd ?? device.model ?? '',
    device.apiLevel?.toString() ?? '',
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
    "List the Android emulators and devices, and the AVDs that don't run",
  readOnly: true,
  input: z.object({}),
  output: z.object({
    devices: z.array(deviceSchema),
    warnings: z.array(z.string()),
  }),
  run: (_input, context) => listAndroidDevices(context),
  format: ({ devices, warnings }) => {
    const lines =
      devices.length > 0
        ? table([HEADER, ...devices.map(row)])
        : ['No devices, and no AVDs.']
    const details = devices
      .filter((device) => device.detail)
      .map((device) => `${device.serial}: ${device.detail}`)
    return [
      ...lines,
      ...details,
      ...warnings.map((warning) => `Warning: ${warning}`),
    ].join('\n')
  },
})
