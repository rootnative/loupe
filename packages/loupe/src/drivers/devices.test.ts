import { describe, expect, it } from 'vitest'
import {
  byCommand,
  fakeContext,
  type FakeRun,
  missingTool,
} from '../testing/fake-exec'
import { type LoupeError } from '../core/errors'
import { listDevices } from './devices'

const NO_ANDROID = {
  'adb devices -l': { stdout: 'List of devices attached\n\n' },
  'emulator -list-avds': { stdout: 'Small_API_30\n' },
}
const ONE_SIMULATOR = {
  'xcrun simctl list --json': {
    stdout: JSON.stringify({
      runtimes: [{ identifier: 'ios-18', name: 'iOS 18.6', platform: 'iOS' }],
      devices: {
        'ios-18': [{ udid: 'AAAA-1', name: 'iPhone 16', state: 'Booted' }],
      },
    }),
  },
}
const NO_XCODE = {
  'xcrun simctl list --json': {
    code: 72,
    stderr: 'xcrun: error: unable to find utility "simctl"\n',
  },
}
const NO_ADB = {
  'adb devices -l': missingTool('adb'),
  'emulator -list-avds': missingTool('emulator'),
}

function mac(runs: Record<string, FakeRun | LoupeError>) {
  return fakeContext(byCommand(runs), {}, 'darwin')
}

describe('listDevices', () => {
  it('lists the Android devices, then the iOS simulators, on a Mac', async () => {
    const { context } = mac({ ...NO_ANDROID, ...ONE_SIMULATOR })

    expect(await listDevices(context)).toMatchObject({
      devices: [
        { platform: 'android', avd: 'Small_API_30' },
        { platform: 'ios', udid: 'AAAA-1', state: 'ready' },
      ],
      warnings: [],
    })
  })

  it('asks only the Android tools on another system', async () => {
    const { context, calls } = fakeContext(byCommand(NO_ANDROID))

    expect((await listDevices(context)).devices).toHaveLength(1)
    expect(calls.map((call) => call.file)).toEqual(['adb', 'emulator'])
  })

  it('warns in place of the simulators on a Mac with no Xcode', async () => {
    const { context } = mac({ ...NO_ANDROID, ...NO_XCODE })

    expect(await listDevices(context)).toMatchObject({
      devices: [{ platform: 'android' }],
      warnings: [
        'The list has no iOS simulators. simctl exited with code 72: xcrun: error: unable to find utility "simctl"',
      ],
    })
  })

  it('warns in place of the Android devices on a Mac with no Android SDK', async () => {
    const { context } = mac({ ...NO_ADB, ...ONE_SIMULATOR })
    const { devices, warnings } = await listDevices(context)

    expect(devices).toMatchObject([{ platform: 'ios', udid: 'AAAA-1' }])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(
      /^The list has no Android devices\. loupe can't find adb\./,
    )
  })

  it('fails with the error of Android when no platform gives a list', async () => {
    const { context } = mac({ ...NO_ADB, ...NO_XCODE })

    await expect(listDevices(context)).rejects.toMatchObject({
      code: 'tool_missing',
      message: expect.stringMatching(/^loupe can't find adb\./),
    })
  })

  it('still fails without adb on another system', async () => {
    const { context } = fakeContext(byCommand(NO_ADB))

    await expect(listDevices(context)).rejects.toMatchObject({
      code: 'tool_missing',
    })
  })
})
