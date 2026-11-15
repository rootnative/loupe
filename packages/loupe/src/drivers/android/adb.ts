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
      result: (args, options) => adb.result(['-s', serial, ...args], options),
    }),
  }
}

/**
 * Quotes a value for the shell on the device. `adb shell` joins its
 * arguments into one command line, so a value with a space or a quote needs
 * this to stay one argument.
 */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}
