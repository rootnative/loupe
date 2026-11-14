import { describe, expect, it } from 'vitest'
import {
  byCommand,
  type FakeRun,
  fakeContext,
  missingTool,
} from '../../testing/fake-exec'
import { API_LEVELS, recorded } from '../../testing/fixtures'
import { listAndroidDevices, selectAndroidDevice } from './devices'

describe.each(API_LEVELS)('listAndroidDevices, on API %i', (level) => {
  it('lists the emulator with its AVD, model, and API level', async () => {
    const api = `api-${level}`
    const { context } = fakeContext(
      byCommand({
        'adb devices -l': recorded(`${api}/host/adb-devices-l.txt`),
        'adb -s emulator-5554 emu avd name': recorded(
          `${api}/host/emu-avd-name.txt`,
        ),
        'adb -s emulator-5554 shell getprop': recorded(
          `${api}/device/getprop.txt`,
        ),
        'emulator -list-avds': recorded(`${api}/host/emulator-list-avds.txt`),
      }),
    )

    expect(await listAndroidDevices(context)).toEqual({
      devices: [
        {
          platform: 'android',
          kind: 'emulator',
          serial: 'emulator-5554',
          avd: 'test',
          model: expect.stringMatching(/^sdk_gphone/),
          state: 'ready',
          apiLevel: level,
        },
      ],
      warnings: [],
    })
  })
})

function adbDevices(...lines: string[]): FakeRun {
  return { stdout: ['List of devices attached', ...lines, ''].join('\n') }
}

function getprop(props: Record<string, string>): FakeRun {
  const lines = Object.entries(props).map(
    ([key, value]) => `[${key}]: [${value}]`,
  )
  return { stdout: `${lines.join('\n')}\n` }
}

function avdName(name: string): FakeRun {
  return { stdout: `${name}\r\nOK\r\n` }
}

const READY_EMULATOR =
  'emulator-5554          device product:sdk_gphone64_arm64 model:sdk_gphone64_arm64 device:emu64a transport_id:1'
const OFFLINE_EMULATOR = 'emulator-5556          offline transport_id:2'
const UNAUTHORIZED_PHONE =
  '0123456789ABCDEF       unauthorized usb:1-1 transport_id:3'
const READY_PHONE =
  'PHONE123               device product:phone model:Phone_Model device:phone transport_id:4'
const NO_PERMISSIONS_STATE =
  'no permissions (missing udev rules? user is in the plugdev group); see [http://developer.android.com/tools/device.html]'
const NO_PERMISSIONS_PHONE = `NOPERM1                ${NO_PERMISSIONS_STATE} usb:1-2 transport_id:5`

const EMULATOR_34 = getprop({
  'ro.build.version.sdk': '34',
  'ro.product.model': 'sdk_gphone64_arm64',
  'ro.kernel.qemu': '1',
  'sys.boot_completed': '1',
})
const PHONE_35 = getprop({
  'ro.build.version.sdk': '35',
  'ro.product.model': 'Phone Model',
  'sys.boot_completed': '1',
})
const AVDS = { stdout: 'Pixel_8_API_34\nTablet_API_35\nSmall_API_30\n' }

describe('listAndroidDevices', () => {
  it('lists each device that adb sees, then the AVDs that do not run', async () => {
    const { context } = fakeContext(
      byCommand({
        'adb devices -l': adbDevices(
          READY_EMULATOR,
          OFFLINE_EMULATOR,
          UNAUTHORIZED_PHONE,
          READY_PHONE,
          NO_PERMISSIONS_PHONE,
        ),
        'adb -s emulator-5554 emu avd name': avdName('Pixel_8_API_34'),
        'adb -s emulator-5554 shell getprop': EMULATOR_34,
        'adb -s emulator-5556 emu avd name': avdName('Tablet_API_35'),
        'adb -s PHONE123 shell getprop': PHONE_35,
        'emulator -list-avds': AVDS,
      }),
    )

    expect(await listAndroidDevices(context)).toEqual({
      devices: [
        {
          platform: 'android',
          kind: 'emulator',
          serial: 'emulator-5554',
          avd: 'Pixel_8_API_34',
          model: 'sdk_gphone64_arm64',
          state: 'ready',
          apiLevel: 34,
        },
        {
          platform: 'android',
          kind: 'emulator',
          serial: 'emulator-5556',
          avd: 'Tablet_API_35',
          state: 'offline',
        },
        {
          platform: 'android',
          kind: 'device',
          serial: '0123456789ABCDEF',
          state: 'unauthorized',
        },
        {
          platform: 'android',
          kind: 'device',
          serial: 'PHONE123',
          model: 'Phone Model',
          state: 'ready',
          apiLevel: 35,
        },
        {
          platform: 'android',
          kind: 'device',
          serial: 'NOPERM1',
          state: 'no-permissions',
          detail: NO_PERMISSIONS_STATE,
        },
        {
          platform: 'android',
          kind: 'emulator',
          avd: 'Small_API_30',
          state: 'stopped',
        },
      ],
      warnings: [],
    })
  })

  it('marks an emulator that has not finished its boot', async () => {
    const { context } = fakeContext(
      byCommand({
        'adb devices -l': adbDevices(READY_EMULATOR),
        'adb -s emulator-5554 emu avd name': avdName('Pixel_8_API_34'),
        'adb -s emulator-5554 shell getprop': getprop({
          'ro.build.version.sdk': '34',
          'sys.boot_completed': '',
        }),
        'emulator -list-avds': AVDS,
      }),
    )

    const { devices } = await listAndroidDevices(context)

    expect(devices[0]).toMatchObject({
      serial: 'emulator-5554',
      state: 'booting',
    })
  })

  it('warns when one device or the emulator tool fails, and lists the rest', async () => {
    const { context } = fakeContext(
      byCommand({
        'adb devices -l': adbDevices(READY_EMULATOR, READY_PHONE),
        'adb -s emulator-5554 emu avd name': {
          code: 1,
          stderr: 'error: could not connect to TCP port 5554\n',
        },
        'adb -s emulator-5554 shell getprop': EMULATOR_34,
        'adb -s PHONE123 shell getprop': { code: 1, stderr: 'error: closed\n' },
        'emulator -list-avds': missingTool('emulator'),
      }),
    )

    expect(await listAndroidDevices(context)).toEqual({
      devices: [
        {
          platform: 'android',
          kind: 'emulator',
          serial: 'emulator-5554',
          model: 'sdk_gphone64_arm64',
          state: 'ready',
          apiLevel: 34,
        },
        {
          platform: 'android',
          kind: 'device',
          serial: 'PHONE123',
          model: 'Phone_Model',
          state: 'ready',
        },
      ],
      warnings: [
        "loupe can't read the AVD name of emulator-5554. adb exited with code 1: error: could not connect to TCP port 5554",
        "loupe can't read the properties of PHONE123. adb exited with code 1: error: closed",
        "The list has no stopped AVDs. loupe can't find emulator. It looked on the PATH. Install the Android Emulator, or set ANDROID_HOME to the folder of your Android SDK.",
      ],
    })
  })

  it('fails when adb is missing', async () => {
    const { context } = fakeContext(
      byCommand({ 'adb devices -l': missingTool('adb') }),
    )

    await expect(listAndroidDevices(context)).rejects.toMatchObject({
      code: 'tool_missing',
    })
  })
})

describe('selectAndroidDevice', () => {
  const twoReady = {
    'adb devices -l': adbDevices(READY_EMULATOR, READY_PHONE),
    'adb -s emulator-5554 emu avd name': avdName('Pixel_8_API_34'),
    'adb -s emulator-5554 shell getprop': EMULATOR_34,
    'adb -s PHONE123 shell getprop': PHONE_35,
  }

  it('picks the only ready device, and gives an adb for it', async () => {
    const { context, calls } = fakeContext(
      byCommand({
        'adb devices -l': adbDevices(OFFLINE_EMULATOR, READY_EMULATOR),
        'adb -s emulator-5554 shell getprop': EMULATOR_34,
        'adb -s emulator-5554 shell wm size': {
          stdout: 'Physical size: 1080x2400\n',
        },
      }),
    )

    const target = await selectAndroidDevice(context)
    await target.adb.text(['shell', 'wm', 'size'])

    expect(target).toMatchObject({
      serial: 'emulator-5554',
      kind: 'emulator',
      apiLevel: 34,
    })
    expect(calls.at(-1)?.args).toEqual([
      '-s',
      'emulator-5554',
      'shell',
      'wm',
      'size',
    ])
  })

  it('picks the device that has the serial', async () => {
    const { context } = fakeContext(byCommand(twoReady))

    expect(await selectAndroidDevice(context, 'PHONE123')).toMatchObject({
      serial: 'PHONE123',
      kind: 'device',
      apiLevel: 35,
    })
  })

  it('picks the emulator that runs the AVD', async () => {
    const { context } = fakeContext(byCommand(twoReady))

    expect(await selectAndroidDevice(context, 'Pixel_8_API_34')).toMatchObject({
      serial: 'emulator-5554',
    })
  })

  it('uses ANDROID_SERIAL when no device is given', async () => {
    const { context } = fakeContext(byCommand(twoReady), {
      ANDROID_SERIAL: 'PHONE123',
    })

    expect(await selectAndroidDevice(context)).toMatchObject({
      serial: 'PHONE123',
    })
  })

  it('fails when more than one device is ready', async () => {
    const { context } = fakeContext(byCommand(twoReady))

    await expect(selectAndroidDevice(context)).rejects.toMatchObject({
      code: 'device_ambiguous',
      message:
        '2 devices are ready: emulator-5554 (sdk_gphone64_arm64), PHONE123 (Phone_Model). Choose one with the "device" option.',
    })
  })

  it('fails when no device is connected', async () => {
    const { context } = fakeContext(
      byCommand({ 'adb devices -l': adbDevices() }),
    )

    await expect(selectAndroidDevice(context)).rejects.toMatchObject({
      code: 'no_device',
    })
  })

  it('fails when no device has the name', async () => {
    const { context } = fakeContext(
      byCommand({ ...twoReady, 'emulator -list-avds': AVDS }),
    )

    await expect(selectAndroidDevice(context, 'Nothing')).rejects.toMatchObject(
      {
        code: 'no_device',
        message:
          'No device has the serial or the AVD name "Nothing". Run "loupe devices" to see the list.',
      },
    )
  })

  it('says when the AVD does not run', async () => {
    const { context } = fakeContext(
      byCommand({ ...twoReady, 'emulator -list-avds': AVDS }),
    )

    await expect(
      selectAndroidDevice(context, 'Small_API_30'),
    ).rejects.toMatchObject({
      code: 'device_unavailable',
      message: "The AVD Small_API_30 doesn't run. Start it, then try again.",
    })
  })

  it.each([
    [
      OFFLINE_EMULATOR,
      'emulator-5556 is offline. Wait until adb connects to it, then try again.',
    ],
    [
      UNAUTHORIZED_PHONE,
      "0123456789ABCDEF doesn't allow USB debugging from this computer yet. Accept the prompt on the device, then try again.",
    ],
    [
      NO_PERMISSIONS_PHONE,
      `loupe can't use NOPERM1. adb reports: ${NO_PERMISSIONS_STATE}`,
    ],
    [
      'RECOVERY1              recovery usb:1-3 transport_id:6',
      "RECOVERY1 isn't ready. adb reports: recovery",
    ],
  ])('says why the only device is not ready: %s', async (line, message) => {
    const { context } = fakeContext(
      byCommand({ 'adb devices -l': adbDevices(line) }),
    )

    await expect(selectAndroidDevice(context)).rejects.toMatchObject({
      code: 'device_unavailable',
      message,
    })
  })

  it('lists the states when no device of several is ready', async () => {
    const { context } = fakeContext(
      byCommand({
        'adb devices -l': adbDevices(OFFLINE_EMULATOR, UNAUTHORIZED_PHONE),
      }),
    )

    await expect(selectAndroidDevice(context)).rejects.toMatchObject({
      code: 'device_unavailable',
      message:
        'No device is ready: emulator-5556 (offline), 0123456789ABCDEF (unauthorized). Run "loupe devices" for details.',
    })
  })

  it('fails for an emulator that has not finished its boot', async () => {
    const { context } = fakeContext(
      byCommand({
        'adb devices -l': adbDevices(READY_EMULATOR),
        'adb -s emulator-5554 shell getprop': getprop({
          'ro.build.version.sdk': '34',
        }),
      }),
    )

    await expect(selectAndroidDevice(context)).rejects.toMatchObject({
      code: 'device_unavailable',
      message:
        "emulator-5554 is still booting. Wait until it's ready, then try again.",
    })
  })

  it('fails below API level 30', async () => {
    const { context } = fakeContext(
      byCommand({
        'adb devices -l': adbDevices(READY_PHONE),
        'adb -s PHONE123 shell getprop': getprop({
          'ro.build.version.sdk': '29',
          'sys.boot_completed': '1',
        }),
      }),
    )

    await expect(selectAndroidDevice(context)).rejects.toMatchObject({
      code: 'unsupported',
      message:
        'PHONE123 runs API level 29. loupe needs Android 11 (API level 30) or later.',
    })
  })
})
