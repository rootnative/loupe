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
        'Serial         State           Kind      Name            API',
        'emulator-5554  ready           emulator  Pixel_8_API_34  34',
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
      /^No devices, and no AVDs\.\nWarning: The list has no stopped AVDs\./,
    )
  })
})
