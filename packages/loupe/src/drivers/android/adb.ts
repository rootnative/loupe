import { type CommandContext } from '../../core/context'
import { ADB, createSdkTool, type SdkTool } from './sdk-tool'

export interface Adb extends SdkTool {
  /** The same adb, with `-s <serial>` before each command. */
  forDevice(serial: string): SdkTool
}

export function createAdb(context: CommandContext): Adb {
  const adb = createSdkTool(context, ADB)
  return {
    ...adb,
    forDevice: (serial) => ({
      run: (args, options) => adb.run(['-s', serial, ...args], options),
      text: (args, options) => adb.text(['-s', serial, ...args], options),
    }),
  }
}
