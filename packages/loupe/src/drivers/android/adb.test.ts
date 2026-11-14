import { describe, expect, it } from 'vitest'
import { fakeContext } from '../../testing/fake-exec'
import { createAdb } from './adb'

describe('createAdb', () => {
  it('runs a command on no device in particular', async () => {
    const { context, calls } = fakeContext(() => ({ stdout: '' }))

    await createAdb(context).run(['devices', '-l'])

    expect(calls.map((call) => call.args)).toEqual([['devices', '-l']])
  })

  it('puts the serial before each command for one device', async () => {
    const { context, calls } = fakeContext(() => ({ stdout: '34\n' }))
    const device = createAdb(context).forDevice('emulator-5554')

    expect(
      await device.text(['shell', 'getprop', 'ro.build.version.sdk']),
    ).toBe('34\n')
    await device.run(['exec-out', 'screencap', '-p'], { timeout: 5000 })

    expect(calls).toEqual([
      {
        file: 'adb',
        args: [
          '-s',
          'emulator-5554',
          'shell',
          'getprop',
          'ro.build.version.sdk',
        ],
      },
      {
        file: 'adb',
        args: ['-s', 'emulator-5554', 'exec-out', 'screencap', '-p'],
        options: { timeout: 5000 },
      },
    ])
  })
})
