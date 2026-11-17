import { describe, expect, it } from 'vitest'
import { type UiNode } from '../../core/ui'
import { byCommand, type FakeRun, fakeContext } from '../../testing/fake-exec'
import { API_LEVELS, recorded, recordedText } from '../../testing/fixtures'
import { selectAndroidDevice } from './devices'
import { readAndroidUi } from './ui'

const ADB = 'adb -s emulator-5554'
const SCALE = 2.625

function emulator(level: number, displayDump: string, dump: FakeRun) {
  const api = `api-${level}`
  const { context, calls } = fakeContext(
    byCommand({
      'adb devices -l': recorded(`${api}/host/adb-devices-l.txt`),
      [`${ADB} shell getprop`]: recorded(`${api}/device/getprop.txt`),
      [`${ADB} shell dumpsys window displays`]: recorded(
        `${api}/${displayDump}`,
      ),
      [`${ADB} exec-out uiautomator dump /dev/tty`]: dump,
    }),
  )
  return { calls, target: () => selectAndroidDevice(context) }
}

function settings(level: number) {
  return emulator(
    level,
    'none/rotation-1/settings/dumpsys-window-displays.txt',
    recorded(`api-${level}/none/rotation-1/settings.ui-tty.txt`),
  )
}

function everyNode(nodes: readonly UiNode[]): UiNode[] {
  return nodes.flatMap((node) => [node, ...everyNode(node.children ?? [])])
}

/** The bounds in px of "Network & internet", and the counts in each dump. */
const RECORDED = [
  { level: 30, title: [189, 630, 534, 687], nodes: 49, clickable: 7 },
  { level: 33, title: [317, 759, 753, 830], nodes: 33, clickable: 4 },
  { level: 34, title: [317, 759, 753, 830], nodes: 33, clickable: 4 },
  { level: 35, title: [317, 759, 753, 830], nodes: 33, clickable: 4 },
  { level: 36, title: [338, 605, 774, 676], nodes: 39, clickable: 5 },
] as const

it('has a row for each recorded API level', () => {
  expect(RECORDED.map((row) => row.level)).toEqual(API_LEVELS)
})

describe.each(RECORDED)('readAndroidUi, on API $level', (recording) => {
  it('reads every node, with frames in dp', async () => {
    const { level, nodes, clickable } = recording
    const [left, top, right, bottom] = recording.title
    const { target } = settings(level)

    const ui = await readAndroidUi(await target())
    const all = everyNode(ui.nodes)

    expect(ui.app).toBe('com.android.settings')
    expect(ui.display).toMatchObject({ orientation: 'landscape-left' })
    expect(all).toHaveLength(nodes)
    expect(all.filter((node) => node.clickable)).toHaveLength(clickable)
    expect(all.find((node) => node.text === 'Network & internet')).toEqual({
      type: 'android.widget.TextView',
      text: 'Network & internet',
      id: 'android:id/title',
      frame: {
        x: left / SCALE,
        y: top / SCALE,
        width: (right - left) / SCALE,
        height: (bottom - top) / SCALE,
      },
    })
  })
})

describe('readAndroidUi', () => {
  it('reads a system sheet in place of the app below it', async () => {
    const { target } = emulator(
      36,
      'none/rotation-3/settings/dumpsys-window-displays.txt',
      recorded('api-36/extra/share.ui-tty.txt'),
    )

    const ui = await readAndroidUi(await target())

    expect(ui.app).toBe('android')
    expect(ui.display.orientation).toBe('landscape-right')
  })

  it('fails when the screen turned during the dump', async () => {
    const { target } = emulator(
      36,
      'none/rotation-1/settings/dumpsys-window-displays.txt',
      recorded('api-36/extra/share.ui-tty.txt'),
    )

    await expect(readAndroidUi(await target())).rejects.toMatchObject({
      code: 'tool_failed',
      message: expect.stringContaining('turned'),
    })
  })

  // No recording has these outputs. The lines are the ones that
  // uiautomator's dump command prints.
  it('gives not_idle when the screen never keeps still', async () => {
    const { target } = emulator(
      36,
      'none/rotation-1/settings/dumpsys-window-displays.txt',
      { stdout: 'ERROR: could not get idle state.\n' },
    )

    await expect(readAndroidUi(await target())).rejects.toMatchObject({
      code: 'not_idle',
    })
  })

  it('gives the first line of other output with no tree', async () => {
    const { target } = emulator(
      36,
      'none/rotation-1/settings/dumpsys-window-displays.txt',
      {
        stdout: '\nERROR: null root node returned by UiTestAutomationBridge.\n',
      },
    )

    await expect(readAndroidUi(await target())).rejects.toMatchObject({
      code: 'tool_failed',
      message:
        'uiautomator on emulator-5554 gave no tree: ERROR: null root node returned by UiTestAutomationBridge.',
    })
  })

  it('fails on a tree that is cut short', async () => {
    const { target } = emulator(
      36,
      'none/rotation-1/settings/dumpsys-window-displays.txt',
      {
        stdout: '<hierarchy rotation="1"><node index="0" bounds="[0,0][1,1]">',
      },
    )

    await expect(readAndroidUi(await target())).rejects.toMatchObject({
      code: 'tool_failed',
      message: expect.stringContaining("<node> isn't closed."),
    })
  })

  it('reads nothing while another app is in front', async () => {
    const { calls, target } = settings(36)

    await expect(
      readAndroidUi(await target(), 'com.example.app'),
    ).rejects.toMatchObject({ code: 'app_not_in_front' })
    expect(calls.some((call) => call.args.includes('uiautomator'))).toBe(false)
  })
})

/** The probe app in Expo Go, from the probe recorder (round 5). */
function probeApp(level: number, step: string, dump?: FakeRun) {
  return emulator(
    level,
    `probe/${step}/dumpsys-window-displays.txt`,
    dump ?? recorded(`api-${level}/probe/${step}/last.ui-tty.txt`),
  )
}

/**
 * The safe area in px in landscape-left with the hole cutout on the left.
 * API 30 has the 3-button navigation bar on the right; the later images
 * have the gesture bar at the bottom.
 */
function holeOnTheLeft(level: number): [number, number, number, number] {
  return level === 30 ? [74, 126, 0, 136] : [63, 0, 63, 136]
}

describe.each(API_LEVELS)(
  'readAndroidUi of the probe app, on API %i',
  (level) => {
    it("leaves the probe's node out, and gives its report", async () => {
      const { target } = probeApp(level, 'hole/rotation-1')
      const dump = recordedText(
        `api-${level}/probe/hole/rotation-1/last.ui-tty.txt`,
      )

      const ui = await readAndroidUi(await target())
      const all = everyNode(ui.nodes)

      expect(ui.app).toBe('host.exp.exponent')
      expect(dump.match(/<node /g)).toHaveLength(all.length + 1)
      expect(all.some((node) => node.label?.startsWith('loupe:'))).toBe(false)
      expect(all.some((node) => node.label === 'safe area')).toBe(true)
      expect(ui.probe).toEqual({
        report: {
          insets: expect.any(Object),
          window: expect.any(Object),
          scale: SCALE,
          direction: 'ltr',
          colorScheme: 'light',
          route: '/',
        },
        warnings: [],
      })
      const insets = ui.probe?.report?.insets
      const [top, right, bottom, left] = holeOnTheLeft(level)
      expect(insets?.top).toBeCloseTo(top / SCALE, 5)
      expect(insets?.right).toBeCloseTo(right / SCALE, 5)
      expect(insets?.bottom).toBeCloseTo(bottom / SCALE, 5)
      expect(insets?.left).toBeCloseTo(left / SCALE, 5)
    })
  },
)

describe('readAndroidUi and the probe', () => {
  it('gives no probe for a screen with none', async () => {
    const { target } = settings(36)

    expect((await readAndroidUi(await target())).probe).toBeUndefined()
  })

  // A compressed dump leaves out the views that aren't important for
  // accessibility, and the probe is one.
  it('gives no probe for the probe app in a compressed dump', async () => {
    const { target } = probeApp(
      36,
      'none/rotation-0',
      recorded('api-36/probe/extra/ui-compressed.txt'),
    )

    const ui = await readAndroidUi(await target())

    expect(ui.probe).toBeUndefined()
    expect(everyNode(ui.nodes).some((node) => node.label === 'safe area')).toBe(
      true,
    )
  })

  it('leaves out a probe node that it cannot read, with a warning', async () => {
    const dump = recordedText('api-36/probe/hole/rotation-3/last.ui-tty.txt')
    const { target } = probeApp(36, 'hole/rotation-3', {
      stdout: dump.replace('"v":1', '"v":2'),
    })

    const ui = await readAndroidUi(await target())

    expect(ui.probe).toEqual({
      warnings: [expect.stringContaining('format 2')],
    })
    expect(
      everyNode(ui.nodes).some((node) => node.label?.startsWith('loupe:')),
    ).toBe(false)
  })
})
