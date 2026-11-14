import { describe, expect, it } from 'vitest'
import {
  parseAdbDevices,
  parseAvdList,
  parseEmuAvdName,
  parseGetprop,
} from './parse'

describe('parseAdbDevices', () => {
  it('reads the long form, with the fields of each device', () => {
    const text = [
      'List of devices attached',
      'emulator-5554          device product:sdk_gphone64_arm64 model:sdk_gphone64_arm64 device:emu64a transport_id:1',
      '0123456789ABCDEF       unauthorized usb:1-1 transport_id:2',
      '192.168.1.20:5555      device product:phone model:Phone_Model device:phone transport_id:3',
      '',
    ].join('\n')

    expect(parseAdbDevices(text)).toEqual([
      {
        serial: 'emulator-5554',
        adbState: 'device',
        fields: {
          product: 'sdk_gphone64_arm64',
          model: 'sdk_gphone64_arm64',
          device: 'emu64a',
          transport_id: '1',
        },
      },
      {
        serial: '0123456789ABCDEF',
        adbState: 'unauthorized',
        fields: { usb: '1-1', transport_id: '2' },
      },
      {
        serial: '192.168.1.20:5555',
        adbState: 'device',
        fields: {
          product: 'phone',
          model: 'Phone_Model',
          device: 'phone',
          transport_id: '3',
        },
      },
    ])
  })

  it('keeps a state that has spaces', () => {
    const text = [
      'List of devices attached',
      'ABC123                 no permissions (missing udev rules? user is in the plugdev group); see [http://developer.android.com/tools/device.html] usb:1-2 transport_id:5',
    ].join('\n')

    expect(parseAdbDevices(text)).toEqual([
      {
        serial: 'ABC123',
        adbState:
          'no permissions (missing udev rules? user is in the plugdev group); see [http://developer.android.com/tools/device.html]',
        fields: { usb: '1-2', transport_id: '5' },
      },
    ])
  })

  it('reads the short form, CRLF line ends, and skips the daemon lines', () => {
    const text = [
      '* daemon not running; starting now at tcp:5037',
      '* daemon started successfully',
      'List of devices attached',
      'emulator-5554\tdevice',
      'emulator-5556\toffline',
      '',
    ].join('\r\n')

    expect(parseAdbDevices(text)).toEqual([
      { serial: 'emulator-5554', adbState: 'device', fields: {} },
      { serial: 'emulator-5556', adbState: 'offline', fields: {} },
    ])
  })

  it('reads an empty list', () => {
    expect(parseAdbDevices('List of devices attached\n\n')).toEqual([])
  })
})

describe('parseGetprop', () => {
  it('reads each property, and skips a value that spans more lines', () => {
    const text = [
      '[ro.build.version.sdk]: [34]',
      '[persist.sys.boot.reason.history]: [reboot,1700000000',
      'reboot,1700000001]',
      '[ro.product.model]: [sdk_gphone64_arm64]',
      '[ro.empty]: []',
      '',
    ].join('\r\n')

    expect(parseGetprop(text)).toEqual({
      'ro.build.version.sdk': '34',
      'ro.product.model': 'sdk_gphone64_arm64',
      'ro.empty': '',
    })
  })
})

describe('parseAvdList', () => {
  it('keeps the AVD names, and skips the log lines', () => {
    const text = [
      'INFO    | Storing crashdata in: /tmp/android-user/emu-crash-35.2.10.db, detection is enabled for process: 4242',
      'Pixel_8_API_34',
      'Tablet.API-35',
      '',
    ].join('\n')

    expect(parseAvdList(text)).toEqual(['Pixel_8_API_34', 'Tablet.API-35'])
  })
})

describe('parseEmuAvdName', () => {
  it('reads the name before "OK"', () => {
    expect(parseEmuAvdName('Pixel_8_API_34\r\nOK\r\n')).toBe('Pixel_8_API_34')
  })

  it('gives undefined for an answer with no name', () => {
    expect(parseEmuAvdName('OK\r\n')).toBeUndefined()
    expect(parseEmuAvdName('KO: unknown command\r\n')).toBeUndefined()
    expect(parseEmuAvdName('')).toBeUndefined()
  })
})
