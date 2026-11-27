import { z } from 'zod'
import { LoupeError } from '../../core/errors'

const listSchema = z.object({
  runtimes: z.array(
    z.object({
      identifier: z.string(),
      name: z.string(),
      platform: z.string().optional(),
      isAvailable: z.boolean().optional(),
    }),
  ),
  devices: z.record(
    z.string(),
    z.array(
      z.object({
        udid: z.string(),
        name: z.string(),
        state: z.string(),
        isAvailable: z.boolean().optional(),
      }),
    ),
  ),
})

export interface SimulatorEntry {
  udid: string
  name: string
  /** As simctl gives it: `Booted`, `Shutdown`, `Booting` and more. */
  state: string
  /** The name of the runtime, for example `iOS 18.6`. */
  os: string
}

/**
 * The iOS simulators of `simctl list --json` that Xcode can start, in the
 * order of the runtimes. The list also has the simulators of tvOS, watchOS
 * and visionOS, and those of a runtime that isn't installed any more.
 */
export function parseSimctlList(text: string): SimulatorEntry[] {
  let list
  try {
    list = listSchema.parse(JSON.parse(text))
  } catch (error) {
    throw new LoupeError(
      'tool_failed',
      "loupe can't read the output of simctl list.",
      { cause: error },
    )
  }
  return list.runtimes
    .filter(
      (runtime) =>
        runtime.isAvailable !== false &&
        // A runtime of an old Xcode has no platform.
        (runtime.platform ?? runtime.name.split(' ')[0]) === 'iOS',
    )
    .flatMap((runtime) =>
      (list.devices[runtime.identifier] ?? [])
        .filter((device) => device.isAvailable !== false)
        .map(({ udid, name, state }) => ({
          udid,
          name,
          state,
          os: runtime.name,
        })),
    )
}
