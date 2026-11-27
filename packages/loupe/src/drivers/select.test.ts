import { describe, expect, it } from 'vitest'
import { type LoupeError } from '../core/errors'
import {
  byCommand,
  fakeContext,
  type FakeRun,
  missingTool,
} from '../testing/fake-exec'
import { selectAndroidOnly, selectDevice } from './select'

type Runs = Record<string, FakeRun | LoupeError>

const SIMCTL = 'xcrun simctl list --json'
const PRO = 'AAAAAAAA-0000-4000-8000-000000000001'
const PRO_26 = 'AAAAAAAA-0000-4000-8000-000000000002'
const MINI = 'AAAAAAAA-0000-4000-8000-000000000003'

function simulators(states: Record<string, string>): Runs {
  return {
    [SIMCTL]: {
      stdout: JSON.stringify({
        runtimes: [
          { identifier: 'ios-18', name: 'iOS 18.6', platform: 'iOS' },
          { identifier: 'ios-26', name: 'iOS 26.2', platform: 'iOS' },
        ],
        devices: {
          'ios-18': [
            {
              udid: PRO,
              name: 'iPhone 16 Pro',
              state: states[PRO] ?? 'Shutdown',
            },
            {
              udid: MINI,
              name: 'iPad mini',
              state: states[MINI] ?? 'Shutdown',
            },
          ],
          'ios-26': [
            {
              udid: PRO_26,
              name: 'iPhone 16 Pro',
              state: states[PRO_26] ?? 'Shutdown',
            },
          ],
        },
      }),
    },
  }
}

const NO_XCODE: Runs = {
  [SIMCTL]: { code: 72, stderr: 'xcrun: error: unable to find utility\n' },
}

function emulator(serial = 'emulator-5554'): Runs {
  return {
    [`adb -s ${serial} emu avd name`]: { stdout: 'Pixel_8\r\nOK\r\n' },
    [`adb -s ${serial} shell getprop`]: {
      stdout: '[ro.build.version.sdk]: [36]\n[sys.boot_completed]: [1]\n',
    },
  }
}

function adbDevices(...serials: string[]): Runs {
  return {
    'adb devices -l': {
      stdout: [
        'List of devices attached',
        ...serials.map((serial) => `${serial}  device model:Pixel_8`),
        '',
      ].join('\n'),
    },
    'emulator -list-avds': { stdout: 'Pixel_8\nSmall_API_30\n' },
  }
}

const NO_ADB: Runs = {
  'adb devices -l': missingTool('adb'),
  'emulator -list-avds': missingTool('emulator'),
}

function mac(runs: Runs, env = {}) {
  return fakeContext(byCommand(runs), env, 'darwin')
}

describe('selectDevice, with no device named', () => {
  it('takes the only simulator that runs', async () => {
    const { context } = mac({
      ...simulators({ [PRO]: 'Booted' }),
      ...adbDevices(),
    })

    expect(await selectDevice(context)).toEqual({
      platform: 'ios',
      target: {
        udid: PRO,
        name: 'iPhone 16 Pro',
        os: 'iOS 18.6',
        signal: undefined,
      },
    })
  })

  it('takes the only simulator that runs on a Mac with no Android SDK', async () => {
    const { context } = mac({ ...simulators({ [MINI]: 'Booted' }), ...NO_ADB })

    expect(await selectDevice(context)).toMatchObject({
      platform: 'ios',
      target: { udid: MINI },
    })
  })

  it('takes the only Android device when no simulator runs', async () => {
    const { context } = mac({
      ...simulators({}),
      ...adbDevices('emulator-5554'),
      ...emulator(),
    })

    expect(await selectDevice(context)).toMatchObject({
      platform: 'android',
      target: { serial: 'emulator-5554', apiLevel: 36 },
    })
  })

  it('takes the only Android device on a Mac with no Xcode', async () => {
    const { context } = mac({
      ...NO_XCODE,
      ...adbDevices('emulator-5554'),
      ...emulator(),
    })

    expect(await selectDevice(context)).toMatchObject({ platform: 'android' })
  })

  it('lists the devices of both platforms when more than one is ready', async () => {
    const { context } = mac({
      ...simulators({ [PRO]: 'Booted' }),
      ...adbDevices('emulator-5554'),
    })

    await expect(selectDevice(context)).rejects.toMatchObject({
      code: 'device_ambiguous',
      message: `2 devices are ready: emulator-5554 (Pixel_8), iPhone 16 Pro (${PRO}, iOS 18.6). Choose one with the "device" option.`,
    })
  })

  it('lists two simulators that run', async () => {
    const { context } = mac({
      ...simulators({ [PRO]: 'Booted', [MINI]: 'Booted' }),
      ...NO_ADB,
    })

    await expect(selectDevice(context)).rejects.toMatchObject({
      code: 'device_ambiguous',
      message: expect.stringMatching(
        /^2 devices are ready: iPhone 16 Pro .*, iPad mini /,
      ),
    })
  })

  it('names both platforms when nothing is ready', async () => {
    const { context } = mac({ ...simulators({}), ...adbDevices() })

    await expect(selectDevice(context)).rejects.toMatchObject({
      code: 'no_device',
      message:
        'loupe finds no Android device, no running emulator and no running iOS simulator. Start one or connect a device, then try again.',
    })
  })

  it('takes the device of ANDROID_SERIAL, and asks no Xcode', async () => {
    const { context, calls } = mac(
      {
        ...adbDevices('emulator-5554', 'emulator-5556'),
        ...emulator('emulator-5556'),
      },
      { ANDROID_SERIAL: 'emulator-5556' },
    )

    expect(await selectDevice(context)).toMatchObject({
      platform: 'android',
      target: { serial: 'emulator-5556' },
    })
    expect(calls.some((call) => call.file === 'xcrun')).toBe(false)
  })
})

describe('selectDevice, with a device named', () => {
  it('takes a simulator by its UDID, in each case of the letters', async () => {
    const { context, calls } = mac(simulators({ [PRO_26]: 'Booted' }))

    expect(await selectDevice(context, PRO_26.toLowerCase())).toMatchObject({
      platform: 'ios',
      target: { udid: PRO_26, os: 'iOS 26.2' },
    })
    expect(calls.map((call) => call.file)).toEqual(['xcrun'])
  })

  it("says that the simulator of a UDID doesn't run, or still boots", async () => {
    const stopped = mac(simulators({}))
    await expect(selectDevice(stopped.context, PRO)).rejects.toMatchObject({
      code: 'device_unavailable',
      message: `The simulator iPhone 16 Pro (${PRO}, iOS 18.6) doesn't run. Start it, then try again.`,
    })

    const booting = mac(simulators({ [PRO]: 'Booting' }))
    await expect(selectDevice(booting.context, PRO)).rejects.toMatchObject({
      code: 'device_unavailable',
      message: `The simulator iPhone 16 Pro (${PRO}, iOS 18.6) is still booting. Wait until it's ready, then try again.`,
    })
  })

  it('takes an Android device by its serial or its AVD name', async () => {
    for (const name of ['emulator-5554', 'Pixel_8']) {
      const { context } = mac({
        ...simulators({ [PRO]: 'Booted' }),
        ...adbDevices('emulator-5554'),
        ...emulator(),
      })

      expect(await selectDevice(context, name)).toMatchObject({
        platform: 'android',
        target: { serial: 'emulator-5554' },
      })
    }
  })

  it('takes the simulator with a name: the one of them that runs', async () => {
    const { context } = mac({
      ...simulators({ [PRO_26]: 'Booted' }),
      ...adbDevices(),
    })

    expect(await selectDevice(context, 'iPhone 16 Pro')).toMatchObject({
      platform: 'ios',
      target: { udid: PRO_26 },
    })
  })

  it('takes a simulator by its name on a Mac with no Android SDK', async () => {
    const { context } = mac({ ...simulators({ [MINI]: 'Booted' }), ...NO_ADB })

    expect(await selectDevice(context, 'iPad mini')).toMatchObject({
      platform: 'ios',
      target: { udid: MINI },
    })
  })

  it('asks for the UDID when two simulators with the name run', async () => {
    const { context } = mac({
      ...simulators({ [PRO]: 'Booted', [PRO_26]: 'Booted' }),
      ...adbDevices(),
    })

    await expect(selectDevice(context, 'iPhone 16 Pro')).rejects.toMatchObject({
      code: 'device_ambiguous',
      message: `2 simulators with the name "iPhone 16 Pro" run: iPhone 16 Pro (${PRO}, iOS 18.6), iPhone 16 Pro (${PRO_26}, iOS 26.2). Give the UDID of one in the "device" option.`,
    })
  })

  it('says when no simulator with the name runs', async () => {
    const { context } = mac({ ...simulators({}), ...adbDevices() })

    await expect(selectDevice(context, 'iPad mini')).rejects.toMatchObject({
      code: 'device_unavailable',
      message: `The simulator iPad mini (${MINI}, iOS 18.6) doesn't run. Start it, then try again.`,
    })
    await expect(selectDevice(context, 'iPhone 16 Pro')).rejects.toMatchObject({
      code: 'device_unavailable',
      message:
        'No simulator with the name "iPhone 16 Pro" runs. Start one, then try again.',
    })
  })

  it('keeps the error of Android for an AVD that does not run', async () => {
    const { context } = mac({ ...simulators({}), ...adbDevices() })

    await expect(selectDevice(context, 'Small_API_30')).rejects.toMatchObject({
      code: 'device_unavailable',
      message: "The AVD Small_API_30 doesn't run. Start it, then try again.",
    })
  })

  it('names each kind of name when no device has it', async () => {
    const { context } = mac({ ...simulators({}), ...adbDevices() })

    await expect(selectDevice(context, 'nothing')).rejects.toMatchObject({
      code: 'no_device',
      message:
        'No device has the serial, the AVD name, the UDID or the simulator name "nothing". Run "loupe devices" to see the list.',
    })
  })

  it('keeps the adb error when no simulator has the name either', async () => {
    const { context } = mac({ ...simulators({}), ...NO_ADB })

    await expect(selectDevice(context, 'nothing')).rejects.toMatchObject({
      code: 'tool_missing',
    })
  })
})

describe('selectDevice on a system that is not macOS', () => {
  it('asks only the Android tools, as before', async () => {
    const { context, calls } = fakeContext(
      byCommand({ ...adbDevices('emulator-5554'), ...emulator() }),
    )

    expect(await selectDevice(context)).toMatchObject({
      platform: 'android',
      target: { serial: 'emulator-5554', kind: 'emulator' },
    })
    expect(calls.map((call) => call.args.join(' '))).toEqual([
      'devices -l',
      '-s emulator-5554 shell getprop',
    ])
  })

  it('keeps the message of Android when no device has the name', async () => {
    const { context } = fakeContext(byCommand(adbDevices()))

    await expect(selectDevice(context, 'nothing')).rejects.toMatchObject({
      code: 'no_device',
      message:
        'No device has the serial or the AVD name "nothing". Run "loupe devices" to see the list.',
    })
  })
})

describe('selectAndroidOnly', () => {
  it('gives the Android target', async () => {
    const { context } = mac({
      ...simulators({}),
      ...adbDevices('emulator-5554'),
      ...emulator(),
    })

    expect(await selectAndroidOnly(context)).toMatchObject({
      serial: 'emulator-5554',
    })
  })

  it('gives unsupported for an iOS simulator, with the way to Android', async () => {
    const { context } = mac({
      ...simulators({ [PRO]: 'Booted' }),
      ...adbDevices(),
    })

    await expect(selectAndroidOnly(context)).rejects.toMatchObject({
      code: 'unsupported',
      message: `This command doesn't work on an iOS simulator yet: only "devices" and "screenshot" do. The device is iPhone 16 Pro (${PRO}, iOS 18.6). For an Android device, give its serial or its AVD name in the "device" option.`,
    })
  })
})
