import { describe, expect, it } from 'vitest'
import { byCommand, fakeContext, missingTool } from '../../testing/fake-exec'
import { recordedIosText } from '../../testing/fixtures'
import { listIosSimulators } from './devices'

const RECORDED = recordedIosText('intel/host/simctl-list.json')
const LIST = 'xcrun simctl list --json'

function mac(stdout: string) {
  return fakeContext(byCommand({ [LIST]: { stdout } }), {}, 'darwin')
}

describe('listIosSimulators', () => {
  it('lists each simulator of the recorded list as stopped', async () => {
    const { devices, warnings } = await listIosSimulators(mac(RECORDED).context)

    expect(warnings).toEqual([])
    expect(devices).toHaveLength(93)
    expect(devices[0]).toEqual({
      platform: 'ios',
      kind: 'simulator',
      udid: '08AEF2F6-6BFD-48DC-9538-9B3FB7DE50B9',
      name: 'iPhone 16 Pro',
      os: 'iOS 18.5',
      state: 'stopped',
    })
    expect(new Set(devices.map((device) => device.state))).toEqual(
      new Set(['stopped']),
    )
  })

  it('puts the simulators that run first, and keeps a state it does not know', async () => {
    // The iPhone 16 Pro of iOS 18.6, and the second simulator of iOS 18.5.
    const running = RECORDED.replace(
      /("udid" : "BEB0C3A5-7D46-4D50-B4C6-777F0A79718D",[^}]*"state" : )"Shutdown"/,
      '$1"Booted"',
    )
      .replace(
        /("udid" : "50AD214F-BB73-4804-9ABB-848A63DCB66E",[^}]*"state" : )"Shutdown"/,
        '$1"Booting"',
      )
      .replace(
        /("udid" : "08AEF2F6-6BFD-48DC-9538-9B3FB7DE50B9",[^}]*"state" : )"Shutdown"/,
        '$1"ShuttingDown"',
      )
    const { devices } = await listIosSimulators(mac(running).context)

    expect(devices.slice(0, 4)).toMatchObject([
      { udid: '08AEF2F6-6BFD-48DC-9538-9B3FB7DE50B9', state: 'other' },
      { udid: '50AD214F-BB73-4804-9ABB-848A63DCB66E', state: 'booting' },
      { udid: 'BEB0C3A5-7D46-4D50-B4C6-777F0A79718D', state: 'ready' },
      { state: 'stopped' },
    ])
    expect(devices[0]?.detail).toBe('ShuttingDown')
    expect(devices[2]?.detail).toBeUndefined()
  })

  it('asks no tool on a system that is not macOS', async () => {
    const { context, calls } = fakeContext(() => undefined)

    expect(await listIosSimulators(context)).toEqual({
      devices: [],
      warnings: [],
    })
    expect(calls).toEqual([])
  })

  it('says to install Xcode when the Mac has no xcrun', async () => {
    const { context } = fakeContext(
      byCommand({ [LIST]: missingTool('xcrun') }),
      {},
      'darwin',
    )

    await expect(listIosSimulators(context)).rejects.toMatchObject({
      code: 'tool_missing',
      message: "loupe can't find xcrun. Install Xcode, then try again.",
    })
  })

  it('gives what xcrun says when it has no simctl', async () => {
    const { context } = fakeContext(
      byCommand({
        [LIST]: {
          code: 72,
          stderr:
            'xcrun: error: unable to find utility "simctl", not a developer tool or in PATH\n',
        },
      }),
      {},
      'darwin',
    )

    await expect(listIosSimulators(context)).rejects.toMatchObject({
      code: 'tool_failed',
      message:
        'simctl exited with code 72: xcrun: error: unable to find utility "simctl", not a developer tool or in PATH',
    })
  })
})
