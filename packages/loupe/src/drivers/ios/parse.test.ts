import { describe, expect, it } from 'vitest'
import { recordedIosText } from '../../testing/fixtures'
import { parseSimctlList } from './parse'

const RECORDED = recordedIosText('intel/host/simctl-list.json')

describe('parseSimctlList', () => {
  it('gives the iOS simulators of the recorded list, in the order of the runtimes', () => {
    const simulators = parseSimctlList(RECORDED)

    expect(simulators).toHaveLength(93)
    expect(simulators[0]).toEqual({
      udid: '08AEF2F6-6BFD-48DC-9538-9B3FB7DE50B9',
      name: 'iPhone 16 Pro',
      state: 'Shutdown',
      os: 'iOS 18.5',
    })
    expect([...new Set(simulators.map((simulator) => simulator.os))]).toEqual([
      'iOS 18.5',
      'iOS 18.6',
      'iOS 26.0',
      'iOS 26.1',
      'iOS 26.2',
    ])
  })

  it('leaves out what Xcode cannot start', () => {
    const list = {
      runtimes: [
        { identifier: 'ios-17', name: 'iOS 17.5', isAvailable: true },
        { identifier: 'ios-16', name: 'iOS 16.4', isAvailable: false },
        { identifier: 'tv', name: 'tvOS 18.5', platform: 'tvOS' },
      ],
      devices: {
        'ios-17': [
          { udid: 'A', name: 'iPhone 15', state: 'Booted', isAvailable: true },
          { udid: 'B', name: 'Broken', state: 'Shutdown', isAvailable: false },
        ],
        'ios-16': [{ udid: 'C', name: 'iPhone 14', state: 'Shutdown' }],
        tv: [{ udid: 'D', name: 'Apple TV', state: 'Shutdown' }],
        'ios-15-removed': [{ udid: 'E', name: 'iPhone 13', state: 'Shutdown' }],
      },
    }

    expect(parseSimctlList(JSON.stringify(list))).toEqual([
      { udid: 'A', name: 'iPhone 15', state: 'Booted', os: 'iOS 17.5' },
    ])
  })

  it('fails with tool_failed on output that is not the list', () => {
    for (const text of ['', 'No devices', '{"devices":[]}']) {
      expect(() => parseSimctlList(text)).toThrow(
        expect.objectContaining({
          code: 'tool_failed',
          message: "loupe can't read the output of simctl list.",
        }),
      )
    }
  })
})
