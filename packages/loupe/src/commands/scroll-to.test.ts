import { describe, expect, it } from 'vitest'
import { run } from '../cli/run'
import { type CommandContext } from '../core/context'
import { runCommand } from '../core/run-command'
import { byCommand, type FakeRun, fakeContext } from '../testing/fake-exec'
import { recorded, recordedText } from '../testing/fixtures'
import { registry } from './index'

const ADB = 'adb -s emulator-5554'
const SETTINGS = 'api-36/none/rotation-1/settings.ui-tty.txt'
const TREE = recordedText(SETTINGS)

/**
 * Settings in landscape-left: the list is 315–1017 px (120–387.43 dp) high.
 * "System" takes the place of "Apps", which the dump gives upside down
 * (off the screen); `cut` puts it at the bottom edge of the list.
 */
function withSystem(bounds: 'cut' | 'whole'): string {
  return TREE.replace('text="Apps"', 'text="System"').replace(
    '[338,1059][460,1017]',
    bounds === 'cut' ? '[338,946][460,1017]' : '[338,740][460,811]',
  )
}

/**
 * Settings on an API 36 emulator. `trees` answers each `uiautomator` dump
 * in order; each `emu` call is a step of a drag through the console.
 */
function settings(trees: readonly string[], level = 36) {
  const base = byCommand({
    'adb devices -l': recorded(`api-${level}/host/adb-devices-l.txt`),
    [`${ADB} shell getprop`]: recorded(`api-${level}/device/getprop.txt`),
    [`${ADB} shell dumpsys window displays`]: recorded(
      `api-${level}/none/rotation-1/settings/dumpsys-window-displays.txt`,
    ),
    [`${ADB} exec-out uiautomator dump /dev/tty`]: trees.map(
      (text): FakeRun => ({ stdout: text }),
    ),
  })
  const { context, calls } = fakeContext((call) =>
    call.args[2] === 'emu' ? { stdout: 'OK\r\n' } : base(call),
  )
  const drags = () =>
    calls.filter((call) => call.args.includes('EV_KEY:BTN_TOUCH:1')).length
  return { context, drags }
}

async function scrollTo(trees: readonly string[], input: object) {
  const { context, drags } = settings(trees)
  const result = await runCommand(registry, 'scroll-to', input, context)
  return { result, drags: drags() }
}

describe('scroll-to', () => {
  it('drags no time when the element is in view', async () => {
    const { result, drags } = await scrollTo([TREE], {
      text: 'Network & internet',
    })

    expect(drags).toBe(0)
    expect(result).toMatchObject({
      ok: true,
      data: {
        orientation: 'landscape-left',
        element: { text: 'Network & internet' },
        direction: 'down',
        scrolls: 0,
      },
    })
    expect(result.ok && result.data).not.toHaveProperty('scrollView')
  })

  it('drags the innermost list until the element shows', async () => {
    const { result, drags } = await scrollTo([TREE, withSystem('whole')], {
      text: 'System',
    })

    expect(drags).toBe(1)
    expect(result).toMatchObject({
      ok: true,
      data: {
        element: { text: 'System' },
        scrolls: 1,
        scrollView: {
          type: 'androidx.recyclerview.widget.RecyclerView',
          id: 'com.android.settings:id/recycler_view',
        },
      },
    })
  })

  it('drags once more by a short way when the list cuts the element', async () => {
    const { result, drags } = await scrollTo(
      [withSystem('cut'), withSystem('whole')],
      { text: 'System' },
    )

    expect(drags).toBe(1)
    expect(result).toMatchObject({
      ok: true,
      data: {
        scrolls: 1,
        element: { frame: { y: expect.closeTo(281.9, 1) } },
      },
    })
  })

  it('stops when a drag leaves the list as it was', async () => {
    const { result, drags } = await scrollTo([TREE], { text: 'System' })

    expect(drags).toBe(1)
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'element_not_found',
        message:
          'The element with the text "System" didn\'t show: the scroll view stopped moving after 1 drag down.',
      },
    })
  })

  it('stops at the most drags', async () => {
    const moved = TREE.replace('text="Google"', 'text="Gmail"')

    const { result, drags } = await scrollTo([TREE, moved], {
      text: 'System',
      maxScrolls: 1,
    })

    expect(drags).toBe(1)
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'element_not_found',
        message:
          'The element with the text "System" didn\'t show after 1 drag down. Give a higher max-scrolls to go on.',
      },
    })
  })

  it('drags the scroll view with the id', async () => {
    const { result } = await scrollTo([TREE, withSystem('whole')], {
      text: 'System',
      in: 'main_content_scrollable_container',
    })

    expect(result).toMatchObject({
      ok: true,
      data: { scrollView: { type: 'android.widget.ScrollView' } },
    })
  })

  it('drags the inner list on API 33, not the page around it', async () => {
    const tree = recordedText('api-33/none/rotation-1/settings.ui-tty.txt')
    const moved = tree.replace('text="Network &amp; internet"', 'text="System"')
    const { context } = settings([tree, moved], 33)

    const result = await runCommand(
      registry,
      'scroll-to',
      { text: 'System' },
      context,
    )

    expect(result).toMatchObject({
      ok: true,
      data: {
        scrolls: 1,
        scrollView: {
          id: 'com.android.settings:id/main_content_scrollable_container',
          frame: { y: expect.closeTo(268.57, 2) },
        },
      },
    })
  })

  it.each([
    [
      'no scroll view',
      [TREE.replaceAll('scrollable="true"', 'scrollable="false"')],
      { text: 'System' },
      'The element with the text "System" isn\'t on the screen, and no scroll view on the screen scrolls down.',
    ],
    [
      'an id that is no scroll view',
      [TREE],
      { text: 'System', in: 'nope' },
      'No element on the screen has the id "nope".',
    ],
  ])('fails with %s', async (_name, trees, input, message) => {
    const { result } = await scrollTo(trees, input)

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'element_not_found', message },
    })
  })

  it.each([
    ['no element', {}],
    ['two elements', { text: 'System', label: 'System' }],
    ['a direction that is not one', { text: 'System', direction: 'back' }],
  ])('refuses %s', async (_name, input) => {
    const { result } = await scrollTo([TREE], input)

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'invalid_input' },
    })
  })

  it('stops before a drag when the call is cancelled', async () => {
    const controller = new AbortController()
    const { context, drags } = settings([TREE])
    const watched: CommandContext = {
      ...context,
      signal: controller.signal,
      exec: (file, args, options) => {
        if (args.includes('uiautomator')) controller.abort()
        return context.exec(file, args, options)
      },
    }

    const result = await runCommand(
      registry,
      'scroll-to',
      { text: 'System' },
      watched,
    )

    expect(result).toMatchObject({ ok: false, error: { code: 'cancelled' } })
    expect(drags()).toBe(0)
  })

  it('prints where the element is', async () => {
    const { context } = settings([TREE, withSystem('whole')])
    const out: string[] = []
    const io = {
      out: (text: string) => out.push(text),
      err: () => {},
      isTTY: true,
    }

    expect(
      await run(['scroll-to', '--text', 'System'], io, registry, context),
    ).toBe(0)
    expect(out.join('\n').split('\n')).toEqual([
      'landscape-left: 914.29 × 411.43 dp (2400 × 1080 px, scale 2.625)',
      '"System" is in view after 1 drag down: (128.76, 281.9) 46.48 × 27.05 dp',
    ])
  })
})
