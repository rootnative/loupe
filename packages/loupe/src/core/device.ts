import { z } from 'zod'

export const DEVICE_STATES = [
  'ready',
  'booting',
  'stopped',
  'offline',
  'unauthorized',
  'no-permissions',
  'other',
] as const

export const deviceSchema = z.object({
  platform: z.enum(['android', 'ios']),
  kind: z.enum(['emulator', 'device', 'simulator']),
  serial: z
    .string()
    .optional()
    .describe(
      'The adb serial of an Android device. An AVD that does not run has none.',
    ),
  avd: z.string().optional().describe('The AVD name of an emulator.'),
  udid: z.string().optional().describe('The UDID of an iOS simulator.'),
  name: z
    .string()
    .optional()
    .describe('The name of an iOS simulator, for example iPhone 16 Pro.'),
  model: z.string().optional(),
  state: z
    .enum(DEVICE_STATES)
    .describe(
      'Only a ready device takes commands. "stopped" is an AVD or a simulator that does not run.',
    ),
  detail: z
    .string()
    .optional()
    .describe(
      'What adb or simctl reports, for the states "no-permissions" and "other".',
    ),
  apiLevel: z
    .number()
    .int()
    .optional()
    .describe('The API level of an Android device.'),
  os: z
    .string()
    .optional()
    .describe('The runtime of an iOS simulator, for example iOS 18.6.'),
})

export type Device = z.infer<typeof deviceSchema>
export type DeviceState = Device['state']

export interface DeviceList {
  devices: Device[]
  warnings: string[]
}

/** The input field of each command that reads or touches the screen. */
export const appField = z
  .string()
  // The name goes into a shell script on the device, so only these.
  .regex(
    /^[A-Za-z][A-Za-z0-9_.-]*$/,
    'A package name has only letters, digits, "_", "." and "-".',
  )
  .optional()
  .describe(
    'The package of the app under test, for example host.exp.exponent for Expo Go. loupe then works only while that app is in front. A real device needs it.',
  )

/** The input field of each command that works on one device. */
export const deviceField = z
  .string()
  .min(1)
  .optional()
  .describe(
    'The serial or the AVD name of the device. Without it, loupe uses ANDROID_SERIAL, or the only ready device.',
  )
