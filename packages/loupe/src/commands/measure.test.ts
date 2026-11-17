import { describe, expect, it } from 'vitest'
import { run } from '../cli/run'
import { type CommandContext } from '../core/context'
import { runCommand } from '../core/run-command'
import { byCommand, fakeContext } from '../testing/fake-exec'
import { recorded } from '../testing/fixtures'
import { registry } from './index'
import { measureCommand } from './measure'

const ADB = 'adb -s emulator-5554'
const SCALE = 2.625

/**
 * The probe app in Expo Go on API 36, in landscape-left with the hole
 * cutout on the left (round 5). Its "safe area" panel fills the safe area
 * that the app gets: 24, 0, 24 and 51.81 dp.
 */
function probeApp() {
  const path = 'api-36/probe/hole/rotation-1'
  return fakeContext(
    byCommand({
      'adb devices -l': recorded('api-36/host/adb-devices-l.txt'),
      [`${ADB} shell getprop`]: recorded('api-36/device/getprop.txt'),
      [`${ADB} shell dumpsys window displays`]: recorded(
        `${path}/dumpsys-window-displays.txt`,
      ),
      [`${ADB} exec-out uiautomator dump /dev/tty`]: recorded(
        `${path}/last.ui-tty.txt`,
      ),
      [`${ADB} exec-out screencap -p`]: recorded(`${path}/app.png`),
    }),
  )
}

/** The data of a result that must pass, typed by the output schema. */
async function measured(input: object, context: CommandContext) {
  const result = await runCommand(registry, 'measure', input, context)
  if (!result.ok) throw new Error(result.error.message)
  return measureCommand.output.parse(result.data)
}

function printed() {
  const out: string[] = []
  const io = {
    out: (text: string) => out.push(text),
    err: () => {},
    isTTY: true,
  }
  return { io, lines: () => out.join('\n').split('\n') }
}

describe('measure, along a line', () => {
  it('gives the colour runs of a row: the orange inset, then the panel', async () => {
    const { context } = probeApp()

    expect(
      await runCommand(registry, 'measure', { row: 100 }, context),
    ).toEqual({
      ok: true,
      command: 'measure',
      data: {
        orientation: 'landscape-left',
        size: { width: 2400 / SCALE, height: 1080 / SCALE },
        pixels: { width: 2400, height: 1080 },
        scale: SCALE,
        line: {
          axis: 'row',
          at: 263 / SCALE,
          pixel: 263,
          runs: [
            {
              from: 0,
              to: 136 / SCALE,
              length: 136 / SCALE,
              pixels: { from: 0, to: 136 },
              colour: '#e76f51',
            },
            {
              from: 136 / SCALE,
              to: 2400 / SCALE,
              length: 2264 / SCALE,
              pixels: { from: 136, to: 2400 },
              colour: '#ffffff',
            },
          ],
        },
        warnings: [],
      },
    })
  })

  it('reads a column, and keeps the short runs with --min-length 0', async () => {
    const { context } = probeApp()

    const joined = await measured({ column: 457 }, context)
    const each = await measured({ column: 457, minLength: 0 }, context)

    expect(joined.line).toMatchObject({ axis: 'column', pixel: 1200 })
    const runs = joined.line?.runs ?? []
    // The status bar inset, the panel, … the gesture bar inset at the end.
    expect(runs[0]).toMatchObject({ to: 24, colour: '#e76f51' })
    expect(runs[1]).toMatchObject({ from: 24, colour: '#ffffff' })
    expect(runs.at(-1)).toMatchObject({ to: 1080 / SCALE, colour: '#e76f51' })
    expect(runs.some((one) => one.colour === undefined)).toBe(true)
    expect(each.line?.runs.length).toBeGreaterThan(runs.length)
  })

  it("gives invalid_input for a row that isn't on the screen", async () => {
    const { context } = probeApp()

    expect(
      await runCommand(registry, 'measure', { row: 500 }, context),
    ).toMatchObject({
      ok: false,
      error: {
        code: 'invalid_input',
        message:
          "The row 500 dp isn't on the screen: it ends at 411.43 dp in landscape-left.",
      },
    })
  })

  it('prints each run', async () => {
    const { context } = probeApp()
    const { io, lines } = printed()

    expect(await run(['measure', '--row', '100'], io, registry, context)).toBe(
      0,
    )
    expect(lines()).toEqual([
      'landscape-left: 914.29 × 411.43 dp (2400 × 1080 px, scale 2.625)',
      'Row at 100.19 dp (263 px), 2 runs:',
      '  0–51.81 dp (51.81 dp): #e76f51',
      '  51.81–914.29 dp (862.48 dp): #ffffff',
    ])
  })
})

describe('measure, an element', () => {
  it('puts the "safe area" panel on the safe area of the probe', async () => {
    const { context, calls } = probeApp()

    const result = await runCommand(
      registry,
      'measure',
      { label: 'safe area' },
      context,
    )

    expect(result).toMatchObject({
      ok: true,
      data: {
        orientation: 'landscape-left',
        element: {
          type: 'android.view.ViewGroup',
          label: 'safe area',
          frame: {
            x: 136 / SCALE,
            y: 63 / SCALE,
            width: 2264 / SCALE,
            height: 954 / SCALE,
          },
          toScreen: { top: 24, right: 0, bottom: 24, left: 136 / SCALE },
          safeAreaSource: 'probe',
        },
        warnings: [],
      },
    })
    // The probe gives float32 dp, so the panel is 0 dp off to 5 places.
    const { element } = await measured({ label: 'safe area' }, context)
    for (const edge of ['top', 'right', 'bottom', 'left'] as const) {
      expect(element?.toSafeArea[edge]).toBeCloseTo(0, 5)
    }
    expect(element?.offCentre.safeArea.x).toBeCloseTo(0, 5)
    expect(element?.offCentre.screen.x).toBeCloseTo(136 / SCALE / 2, 5)
    // One dump for each of the two runs: the insets reuse it.
    expect(
      calls.filter((call) => call.args.includes('uiautomator')),
    ).toHaveLength(2)
  })

  it('prints where the element sits', async () => {
    const { context } = probeApp()
    const { io, lines } = printed()

    expect(
      await run(['measure', '--text', 'Probe app'], io, registry, context),
    ).toBe(0)
    expect(lines()).toEqual([
      'landscape-left: 914.29 × 411.43 dp (2400 × 1080 px, scale 2.625)',
      '"Probe app": (446.48, 179.81) 73.14 × 21.71 dp',
      'To the screen edges: top 179.81, right 394.67, bottom 209.9, left 446.48 dp',
      'To the safe area (probe): top 155.81, right 394.67, bottom 185.9, left 394.67 dp',
      'Off centre: x 25.9, y -15.05 dp from the screen centre, x 0, y -15.05 dp from the safe-area centre',
    ])
  })

  it('gives element_not_found with no match', async () => {
    const { context } = probeApp()

    expect(
      await runCommand(registry, 'measure', { text: 'Nothing' }, context),
    ).toMatchObject({ ok: false, error: { code: 'element_not_found' } })
  })
})

describe('measure, the input', () => {
  it.each([
    ['no target', {}],
    ['two targets', { row: 1, column: 1 }],
    ['a row and an element', { row: 1, text: 'Probe app' }],
    ['a negative row', { row: -1 }],
    ['a tolerance past 255', { row: 1, tolerance: 256 }],
  ])('refuses %s', async (_name, input) => {
    const { context, calls } = probeApp()

    expect(await runCommand(registry, 'measure', input, context)).toMatchObject(
      { ok: false, error: { code: 'invalid_input' } },
    )
    expect(calls.some((call) => call.args.includes('screencap'))).toBe(false)
  })
})
