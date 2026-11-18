import { describe, expect, it } from 'vitest'
import { API_LEVELS, recordedText } from '../../testing/fixtures'
import {
  parseAdbDevices,
  parseAmStart,
  parseAvdList,
  parseEmuAvdName,
  parseGetprop,
  parseRecentTasks,
  parseUiautomatorDump,
  parseWindowDisplays,
  parseWindowInsets,
  parseWindowList,
} from './parse'
import { type XmlElement } from './xml'

function everyElement(elements: readonly XmlElement[]): XmlElement[] {
  return elements.flatMap((element) => [
    element,
    ...everyElement(element.children),
  ])
}

describe.each(API_LEVELS)('the parsers, on the output of API %i', (level) => {
  const api = `api-${level}`

  it('read adb devices -l', () => {
    expect(
      parseAdbDevices(recordedText(`${api}/host/adb-devices-l.txt`)),
    ).toEqual([
      {
        serial: 'emulator-5554',
        adbState: 'device',
        fields: expect.objectContaining({
          model: expect.stringMatching(/^sdk_gphone/),
          transport_id: '1',
        }),
      },
    ])
  })

  it('read the AVD name and the list of AVDs', () => {
    expect(parseEmuAvdName(recordedText(`${api}/host/emu-avd-name.txt`))).toBe(
      'test',
    )
    expect(
      parseAvdList(recordedText(`${api}/host/emulator-list-avds.txt`)),
    ).toEqual(['test'])
  })

  it('read getprop', () => {
    const props = parseGetprop(recordedText(`${api}/device/getprop.txt`))

    expect(props).toMatchObject({
      'ro.build.version.sdk': `${level}`,
      'ro.kernel.qemu': '1',
      'sys.boot_completed': '1',
    })
    expect(props).not.toHaveProperty('persist.sys.boot.reason.history')
  })

  it('read the display of a turned screen', () => {
    expect(
      parseWindowDisplays(
        recordedText(
          `${api}/none/rotation-1/settings/dumpsys-window-displays.txt`,
        ),
      ),
    ).toEqual({
      natural: { width: 1080, height: 2400 },
      density: 420,
      current: { width: 2400, height: 1080 },
      rotation: 1,
      appOrientation: 'SCREEN_ORIENTATION_UNSPECIFIED',
      focus:
        'com.android.settings/com.android.settings.homepage.SettingsHomepageActivity',
      focusId: expect.stringMatching(/^[0-9a-f]+$/),
    })
  })

  it("read the focus of an app's dialog: the app's title, another window", () => {
    const main = parseWindowDisplays(
      recordedText(
        `${api}/sheets/alert/back/before.dumpsys-window-displays.txt`,
      ),
    )
    const dialog = parseWindowDisplays(
      recordedText(`${api}/sheets/alert/back/open.dumpsys-window-displays.txt`),
    )
    const windows = parseWindowList(
      recordedText(`${api}/sheets/alert/back/open.dumpsys-window-windows.txt`),
    )
    const byId = (id?: string) => windows.find((window) => window.id === id)

    expect(dialog?.focus).toBe(main?.focus)
    expect(dialog?.focusId).not.toBe(main?.focusId)
    expect(byId(main?.focusId)).toEqual({
      id: main?.focusId,
      title: main?.focus,
      package: 'host.exp.exponent',
      type: 'BASE_APPLICATION',
    })
    expect(byId(dialog?.focusId)).toMatchObject({
      package: 'host.exp.exponent',
      type: 'APPLICATION',
    })
    expect(
      windows.find((window) => window.title === 'NotificationShade'),
    ).toMatchObject({
      package: 'com.android.systemui',
      type: level <= 34 ? '2040' : 'NOTIFICATION_SHADE',
    })
  })

  it('read the keyboard in the insets, and each source after it hid', () => {
    const keyboard = (when: string) =>
      parseWindowInsets(
        recordedText(
          `${api}/sheets/keyboard/back/${when}.dumpsys-window-displays.txt`,
        ),
      )?.sources ?? []
    const ime = level <= 33 ? 'ITYPE_IME' : 'ime'
    const navigation = level <= 33 ? 'ITYPE_NAVIGATION_BAR' : 'navigationBars'

    expect(keyboard('open')).toContainEqual(
      expect.objectContaining({
        type: ime,
        frame: {
          x: 0,
          y: level === 30 ? 1533 : 1517,
          width: 1080,
          height: level === 30 ? 867 : 883,
        },
        visible: true,
      }),
    )
    // Once shown, the keyboard's line has a `visibleFrame=`. On API 34 and
    // later it sits before the navigation bar.
    const after = keyboard('after')
    expect(after).toContainEqual(
      expect.objectContaining({
        type: ime,
        frame: { x: 0, y: 0, width: 0, height: 0 },
        visible: false,
      }),
    )
    expect(after).toContainEqual(
      expect.objectContaining({ type: navigation, visible: true }),
    )
  })

  it('read the display under the launcher, which holds portrait', () => {
    expect(
      parseWindowDisplays(
        recordedText(`${api}/none/rotation-1/home/dumpsys-window-displays.txt`),
      ),
    ).toMatchObject({
      current: { width: 1080, height: 2400 },
      rotation: 0,
      appOrientation: 'SCREEN_ORIENTATION_NOSENSOR',
      focus: expect.stringMatching(
        /^com\.google\.android\.apps\.nexuslauncher\//,
      ),
    })
  })
})

describe('parseWindowDisplays', () => {
  it.each([
    [0, 1080, 2400],
    [3, 2400, 1080],
  ])('reads rotation %i', (rotation, width, height) => {
    expect(
      parseWindowDisplays(
        recordedText(
          `api-36/none/rotation-${rotation}/settings/dumpsys-window-displays.txt`,
        ),
      ),
    ).toMatchObject({ rotation, current: { width, height } })
  })

  // No recording has an override, so this line is written by hand in the
  // format of `DisplayContent.dump`.
  it('uses the override size and density from base=', () => {
    const text = [
      '  Display: mDisplayId=0 (organized)',
      '    init=1080x2400 420dpi mMinSizeOfResizeableTaskDp=220 base=1080x2340 480dpi cur=2340x1080 app=2340x1080',
      '    mRotation=1 mDeferredRotationPauseCount=0',
    ].join('\n')

    expect(parseWindowDisplays(text)).toMatchObject({
      natural: { width: 1080, height: 2340 },
      density: 480,
      current: { width: 2340, height: 1080 },
    })
  })

  it('reads the display that has the id', () => {
    const text = [
      '  Display: mDisplayId=2',
      '    init=720x1280 320dpi cur=720x1280 app=720x1280',
      '    mRotation=0 mDeferredRotationPauseCount=0',
      '  Display: mDisplayId=0',
      '    init=1080x2400 420dpi cur=2400x1080 app=2400x1080',
      '    mRotation=1 mDeferredRotationPauseCount=0',
    ].join('\n')

    expect(parseWindowDisplays(text)).toMatchObject({
      density: 420,
      rotation: 1,
    })
    expect(parseWindowDisplays(text, 2)).toMatchObject({
      density: 320,
      rotation: 0,
    })
    expect(parseWindowDisplays(text, 5)).toBeUndefined()
  })

  // No recording has these focus lines, so they're written by hand in the
  // format of the recorded ones.
  it.each([
    ['mCurrentFocus=null', undefined],
    ['mCurrentFocus=Window{1a2b3c u0 NotificationShade}', 'NotificationShade'],
    [
      'mCurrentFocus=Window{1a2b3c u0 Splash Screen com.example.app}\r',
      'Splash Screen com.example.app',
    ],
  ])('reads the focus from "%s"', (line, focus) => {
    const text = [
      '  Display: mDisplayId=0',
      '    init=1080x2400 420dpi cur=1080x2400 app=1080x2400',
      `  ${line}`,
      '    mRotation=0 mDeferredRotationPauseCount=0',
    ].join('\n')

    expect(parseWindowDisplays(text)).toMatchObject({
      focus,
      focusId: focus === undefined ? undefined : '1a2b3c',
    })
  })

  it('reads the focus of the display that has the id', () => {
    const text = [
      '  Display: mDisplayId=0',
      '    init=1080x2400 420dpi cur=1080x2400 app=1080x2400',
      '  mCurrentFocus=null',
      '    mRotation=0 mDeferredRotationPauseCount=0',
      '  Display: mDisplayId=2',
      '    init=720x1280 320dpi cur=720x1280 app=720x1280',
      '  mCurrentFocus=Window{1a2b3c u0 com.example.app/.MainActivity}',
      '    mRotation=0 mDeferredRotationPauseCount=0',
    ].join('\n')

    expect(parseWindowDisplays(text)?.focus).toBeUndefined()
    expect(parseWindowDisplays(text, 2)?.focus).toBe(
      'com.example.app/.MainActivity',
    )
  })

  it('gives undefined when the rotation is missing', () => {
    expect(
      parseWindowDisplays(
        '  Display: mDisplayId=0\n    init=1080x2400 420dpi cur=1080x2400\n',
      ),
    ).toBeUndefined()
  })
})

describe('parseUiautomatorDump', () => {
  it.each(API_LEVELS)(
    'reads the tree, and skips the line after it, on API %i',
    (level) => {
      const dump = parseUiautomatorDump(
        recordedText(`api-${level}/none/rotation-1/settings.ui-tty.txt`),
      )

      expect(dump?.rotation).toBe(1)
      expect(dump?.nodes).toHaveLength(1)
      expect(dump?.nodes[0]?.attributes).toMatchObject({
        class: 'android.widget.FrameLayout',
        package: 'com.android.settings',
      })
    },
  )

  it('decodes a new line in a text', () => {
    const dump = parseUiautomatorDump(
      recordedText('api-33/extra/https.ui-tty.txt'),
    )
    const texts = everyElement(dump?.nodes ?? []).map(
      (element) => element.attributes.text,
    )

    expect(texts).toContainEqual(
      expect.stringContaining('Terms of Service.\nTo help improve the app'),
    )
  })

  it('gives undefined for output with no tree', () => {
    expect(
      parseUiautomatorDump('ERROR: could not get idle state.\n'),
    ).toBeUndefined()
    expect(parseUiautomatorDump('')).toBeUndefined()
  })

  it('throws an error for a tree that is cut short', () => {
    expect(() =>
      parseUiautomatorDump('<hierarchy rotation="0"><node index="0">'),
    ).toThrow("<node> isn't closed.")
  })
})

describe('parseWindowInsets', () => {
  it.each(API_LEVELS)(
    'reads the sources and the cutout in landscape, on API %i',
    (level) => {
      const insets = parseWindowInsets(
        recordedText(
          `api-${level}/hole/rotation-1/settings/dumpsys-window-displays.txt`,
        ),
      )
      const status = level <= 33 ? 'ITYPE_STATUS_BAR' : 'statusBars'
      const cutout = level <= 33 ? 'ITYPE_LEFT_DISPLAY_CUTOUT' : 'displayCutout'

      expect(insets?.cutout).toEqual({ top: 0, right: 0, bottom: 0, left: 136 })
      expect(insets?.cutoutRects).toEqual([
        { x: 0, y: 944, width: 136, height: 136 },
      ])
      expect(insets?.sources).toContainEqual({
        type: status,
        frame: { x: 0, y: 0, width: 2400, height: level === 30 ? 74 : 63 },
        visible: true,
        sideHint: level >= 35 ? 'TOP' : undefined,
      })
      expect(insets?.sources).toContainEqual(
        expect.objectContaining({
          type: cutout,
          frame: { x: 0, y: 0, width: 136, height: 1080 },
        }),
      )
      // The providers repeat the sources after "mSource=": not read twice.
      expect(
        insets?.sources.filter((source) => source.type === status),
      ).toHaveLength(1)
    },
  )

  it('keeps the frame of a cutout side that is not there on API 30', () => {
    const insets = parseWindowInsets(
      recordedText(
        'api-30/hole/rotation-1/settings/dumpsys-window-displays.txt',
      ),
    )

    expect(insets?.sources).toContainEqual(
      expect.objectContaining({
        type: 'ITYPE_TOP_DISPLAY_CUTOUT',
        frame: { x: 0, y: 0, width: 2400, height: -2147483648 },
      }),
    )
  })

  it('gives no sources and no cutout for a dump that has neither', () => {
    expect(
      parseWindowInsets(
        '  Display: mDisplayId=0\n    init=1080x2400 420dpi cur=1080x2400\n',
      ),
    ).toEqual({
      sources: [],
      cutout: { top: 0, right: 0, bottom: 0, left: 0 },
      cutoutRects: [],
    })
  })
})

describe('parseWindowList', () => {
  it('gives the windows from the top', () => {
    const windows = parseWindowList(
      recordedText('api-36/sheets/alert/back/open.dumpsys-window-windows.txt'),
    )

    expect(windows[0]).toEqual({
      id: 'c1c520a',
      title: 'ScreenDecorOverlayBottom',
      package: 'com.android.systemui',
      type: 'NAVIGATION_BAR_PANEL',
    })
    expect(windows.map((window) => window.type).slice(7, 10)).toEqual([
      'APPLICATION',
      'INPUT_METHOD',
      'BASE_APPLICATION',
    ])
  })

  it('gives no window for text with none', () => {
    expect(
      parseWindowList('WINDOW MANAGER WINDOWS (dumpsys window windows)\n'),
    ).toEqual([])
  })
})

describe('parseAmStart', () => {
  it('reads a started activity', () => {
    expect(
      parseAmStart(recordedText('api-30/extra/am-start-https.txt')),
    ).toEqual({
      status: 'ok',
      activity:
        'com.android.chrome/org.chromium.chrome.browser.firstrun.FirstRunActivity',
      launchState: 'COLD',
      totalTime: 669,
      error: undefined,
      unresolved: false,
    })
  })

  it.each([30, 36])(
    'reads an intent that no activity takes, on API %i',
    (level) => {
      expect(
        parseAmStart(
          recordedText(`api-${level}/extra/am-start-no-handler.txt`),
        ),
      ).toMatchObject({ status: undefined, unresolved: true })
    },
  )
})

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

describe('parseRecentTasks', () => {
  const recents = (file: string) => recordedText(`${file}.recents.txt`)

  it('gives the tasks from the one in front, on API 36', () => {
    expect(
      parseRecentTasks(
        recents('api-36/app-switch/expo-go/recents-twice/before'),
      ),
    ).toEqual([
      { id: 9, type: 'standard', package: 'host.exp.exponent' },
      { id: 11, type: 'standard', package: 'host.exp.exponent' },
      { id: 12, type: 'standard', package: 'host.exp.exponent' },
      {
        id: 6,
        type: 'home',
        package: 'com.google.android.apps.nexuslauncher',
      },
      { id: 7, type: 'standard', package: 'com.android.settings' },
    ])
  })

  it('reads the longer header of API 30, and the home screen first after HOME', () => {
    const tasks = parseRecentTasks(
      recents('api-30/app-switch/expo-go/recents-twice/home'),
    )

    expect(tasks.slice(0, 2)).toEqual([
      {
        id: 8,
        type: 'home',
        package: 'com.google.android.apps.nexuslauncher',
      },
      { id: 11, type: 'standard', package: 'host.exp.exponent' },
    ])
    expect(tasks.at(-1)).toEqual({
      id: 4,
      type: 'home',
      package: 'com.android.settings',
    })
  })

  it('gives no task for text with none', () => {
    expect(parseRecentTasks('ACTIVITY MANAGER RECENT TASKS\n')).toEqual([])
  })
})
