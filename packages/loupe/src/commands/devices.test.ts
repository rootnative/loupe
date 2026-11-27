import { describe, expect, it } from 'vitest'
import { runCommand } from '../core/run-command'
import { byCommand, fakeContext, missingTool } from '../testing/fake-exec'
import { devicesCommand } from './devices'
import { registry } from './index'

describe('devices', () => {
  const { context } = fakeContext(
    byCommand({
      'adb devices -l': {
        stdout: [
          'List of devices attached',
          'emulator-5554          device product:sdk_gphone64_arm64 model:sdk_gphone64_arm64 device:emu64a transport_id:1',
          'ABC123                 no permissions (missing udev rules?); see [http://developer.android.com/tools/device.html] usb:1-2 transport_id:2',
          '',
        ].join('\n'),
      },
      'adb -s emulator-5554 emu avd name': {
        stdout: 'Pixel_8_API_34\r\nOK\r\n',
      },
      'adb -s emulator-5554 shell getprop': {
        stdout: '[ro.build.version.sdk]: [34]\n[sys.boot_completed]: [1]\n',
      },
      'emulator -list-avds': { stdout: 'Pixel_8_API_34\nSmall_API_30\n' },
    }),
  )

  it('gives a result that its output schema accepts', async () => {
    const result = await runCommand(registry, 'devices', {}, context)

    expect(result).toMatchObject({
      ok: true,
      data: {
        devices: [
          { serial: 'emulator-5554', avd: 'Pixel_8_API_34', state: 'ready' },
          { serial: 'ABC123', state: 'no-permissions' },
          { avd: 'Small_API_30', state: 'stopped' },
        ],
        warnings: [],
      },
    })
  })

  it('prints a table, the details, and the warnings', async () => {
    const data = await devicesCommand.run({}, context)

    expect(
      devicesCommand.format?.(
        devicesCommand.output.parse({
          ...data,
          warnings: ['The list has no stopped AVDs.'],
        }),
      ),
    ).toBe(
      [
        'Id             State           Kind      Name            OS',
        'emulator-5554  ready           emulator  Pixel_8_API_34  API 34',
        'ABC123         no-permissions  device',
        '-              stopped         emulator  Small_API_30',
        'ABC123: no permissions (missing udev rules?); see [http://developer.android.com/tools/device.html]',
        'Warning: The list has no stopped AVDs.',
      ].join('\n'),
    )
  })

  it('says when the list is empty', async () => {
    const { context: empty } = fakeContext(
      byCommand({
        'adb devices -l': { stdout: 'List of devices attached\n\n' },
        'emulator -list-avds': missingTool('emulator'),
      }),
    )
    const data = await devicesCommand.run({}, empty)

    expect(devicesCommand.format?.(devicesCommand.output.parse(data))).toMatch(
      /^No devices, no AVDs, and no simulators\.\nWarning: The list has no stopped AVDs\./,
    )
  })

  it('lists the iOS simulators on a Mac, after the Android devices', async () => {
    const { context: mac } = fakeContext(
      byCommand({
        'adb devices -l': { stdout: 'List of devices attached\n\n' },
        'emulator -list-avds': { stdout: 'Small_API_30\n' },
        'xcrun simctl list --json': {
          stdout: JSON.stringify({
            runtimes: [
              {
                identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-18-6',
                name: 'iOS 18.6',
                platform: 'iOS',
                isAvailable: true,
              },
            ],
            devices: {
              'com.apple.CoreSimulator.SimRuntime.iOS-18-6': [
                { udid: 'AAAA-1', name: 'iPhone 16', state: 'Shutdown' },
                { udid: 'BBBB-2', name: 'iPhone 16 Pro', state: 'Booted' },
              ],
            },
          }),
        },
      }),
      {},
      'darwin',
    )
    const result = await runCommand(registry, 'devices', {}, mac)

    expect(result).toMatchObject({
      ok: true,
      data: {
        devices: [
          { platform: 'android', avd: 'Small_API_30', state: 'stopped' },
          {
            platform: 'ios',
            kind: 'simulator',
            udid: 'BBBB-2',
            name: 'iPhone 16 Pro',
            os: 'iOS 18.6',
            state: 'ready',
          },
          { platform: 'ios', udid: 'AAAA-1', state: 'stopped' },
        ],
        warnings: [],
      },
    })
    expect(result.ok && devicesCommand.format?.(result.data as never)).toBe(
      [
        'Id      State    Kind       Name           OS',
        '-       stopped  emulator   Small_API_30',
        'BBBB-2  ready    simulator  iPhone 16 Pro  iOS 18.6',
        'AAAA-1  stopped  simulator  iPhone 16      iOS 18.6',
      ].join('\n'),
    )
  })
})

describe('a device command on a Mac', () => {
  it('gives unsupported when the device is an iOS simulator', async () => {
    const { context } = fakeContext(
      byCommand({
        'xcrun simctl list --json': {
          stdout: JSON.stringify({
            runtimes: [
              { identifier: 'ios-18', name: 'iOS 18.6', platform: 'iOS' },
            ],
            devices: {
              'ios-18': [
                { udid: 'AAAA-1', name: 'iPhone 16', state: 'Booted' },
              ],
            },
          }),
        },
      }),
      {},
      'darwin',
    )

    for (const [name, input] of [
      ['ui', {}],
      ['tap', { x: 10, y: 10 }],
      ['rotate', { to: 'portrait' }],
    ] as const) {
      expect(
        await runCommand(
          registry,
          name,
          { ...input, device: 'AAAA-1' },
          context,
        ),
      ).toMatchObject({ ok: false, error: { code: 'unsupported' } })
    }
  })
})
