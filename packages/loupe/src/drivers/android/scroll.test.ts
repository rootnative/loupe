import { describe, expect, it } from 'vitest'
import { byCommand, type FakeRun, fakeContext } from '../../testing/fake-exec'
import { recorded, recordedText } from '../../testing/fixtures'
import { selectAndroidDevice } from './devices'
import { flingToTopAndroid, scrollOnceAndroid } from './scroll'

const ADB = 'adb -s emulator-5554'
const TREE = recordedText('api-36/none/rotation-1/settings.ui-tty.txt')

/**
 * Settings in landscape-left, with another row in the list (120–387.43
 * dp) where "Apps" is off the screen: the list moved.
 */
function moved(text: string, bounds: string): string {
  return TREE.replace('text="Apps"', `text="${text}"`).replace(
    '[338,1059][460,1017]',
    bounds,
  )
}

const MOVED = moved('System', '[338,740][460,811]')
const FURTHER = moved('Display', '[338,600][460,671]')

/** Settings on an API 36 emulator; `dumps` answers each dump in order. */
function settings(dumps: readonly string[]) {
  const base = byCommand({
    'adb devices -l': recorded('api-36/host/adb-devices-l.txt'),
    [`${ADB} shell getprop`]: recorded('api-36/device/getprop.txt'),
    [`${ADB} shell dumpsys window displays`]: recorded(
      'api-36/none/rotation-1/settings/dumpsys-window-displays.txt',
    ),
    [`${ADB} exec-out uiautomator dump /dev/tty`]: dumps.map(
      (text): FakeRun => ({ stdout: text }),
    ),
  })
  const { context, calls } = fakeContext((call) => {
    if (call.args[2] === 'emu') return { stdout: 'OK\r\n' }
    if (call.args[2] === 'shell' && call.args[3] === 'input') return {}
    return base(call)
  })
  return {
    target: () => selectAndroidDevice(context),
    drags: () =>
      calls.filter((call) => call.args.includes('EV_KEY:BTN_TOUCH:1')).length,
    swipes: () =>
      calls
        .filter((call) => call.args[3] === 'input')
        .map((call) => call.args.slice(4)),
  }
}

async function scrolledSettings(dumps: readonly string[]) {
  const device = settings(dumps)
  const target = await device.target()
  const scrolled = await scrollOnceAndroid(target)
  if (!scrolled) throw new Error('The list did not scroll.')
  return { ...device, target, scrolled }
}

describe('scrollOnceAndroid', () => {
  it('drags the list down once, and keeps what it showed before', async () => {
    const { scrolled, drags } = await scrolledSettings([TREE, MOVED])

    expect(drags()).toBe(1)
    expect(scrolled.frame).toMatchObject({
      y: expect.closeTo(120, 1),
      height: expect.closeTo(267.43, 1),
    })
    expect(scrolled.top).toContain('Network & internet')
    expect(scrolled.top).not.toContain('System')
  })

  it('gives nothing when the list shows the same after the drag', async () => {
    const device = settings([TREE, TREE])

    expect(await scrollOnceAndroid(await device.target())).toBeUndefined()
    expect(device.drags()).toBe(1)
  })
})

describe('flingToTopAndroid', () => {
  it('swipes up fast until the list shows its top again', async () => {
    const { target, scrolled, swipes } = await scrolledSettings([
      TREE,
      MOVED,
      TREE,
    ])

    expect(await flingToTopAndroid(target, scrolled)).toEqual([])
    expect(swipes()).toHaveLength(1)
    const [kind, x1, y1, x2, y2, ms] = swipes()[0] ?? []
    expect({ kind, ms }).toEqual({ kind: 'swipe', ms: '100' })
    expect(x2).toBe(x1)
    expect(Number(y1)).toBeLessThan(Number(y2))
  })

  it('stops when the list stops moving short of its top', async () => {
    const { target, scrolled, swipes } = await scrolledSettings([
      TREE,
      FURTHER,
      MOVED,
      MOVED,
    ])

    expect(await flingToTopAndroid(target, scrolled)).toEqual([
      "The scroll view didn't show its top again after 2 fast swipes up, so the next check of this link can start lower down.",
    ])
    expect(swipes()).toHaveLength(2)
  })

  it('swipes 3 times at most', async () => {
    const { target, scrolled, swipes } = await scrolledSettings([
      TREE,
      FURTHER,
      MOVED,
      FURTHER,
      MOVED,
    ])

    expect(await flingToTopAndroid(target, scrolled)).toEqual([
      "The scroll view didn't show its top again after 3 fast swipes up, so the next check of this link can start lower down.",
    ])
    expect(swipes()).toHaveLength(3)
  })
})
