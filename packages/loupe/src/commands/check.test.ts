import { describe, expect, it } from 'vitest'
import { run } from '../cli/run'
import { type CommandContext } from '../core/context'
import { runCommand } from '../core/run-command'
import { byCommand, fakeContext } from '../testing/fake-exec'
import { recorded } from '../testing/fixtures'
import { checkCommand } from './check'
import { registry } from './index'

const ADB = 'adb -s emulator-5554'

/**
 * One screen of the probe app's patterns, from recorder round 6: the hole
 * cutout is on, `step` is the direction and the rotation.
 */
function pattern(level: number, step: string, name: string) {
  const path = `api-${level}/check/${step}`
  return fakeContext(
    byCommand({
      'adb devices -l': recorded(`api-${level}/host/adb-devices-l.txt`),
      [`${ADB} shell getprop`]: recorded(`api-${level}/device/getprop.txt`),
      [`${ADB} shell dumpsys window displays`]: recorded(
        `${path}/dumpsys-window-displays.txt`,
      ),
      [`${ADB} exec-out uiautomator dump /dev/tty`]: recorded(
        `${path}/${name}.ui-tty.txt`,
      ),
    }),
  )
}

/** The data of a result that must be a success, typed by the output. */
async function checked(context: CommandContext, input: object = {}) {
  const result = await runCommand(registry, 'check', input, context)
  if (!result.ok) throw new Error(result.error.message)
  return checkCommand.output.parse(result.data)
}

/** The rules that failed, with their findings in short. */
async function failures(level: number, step: string, name: string) {
  const { context } = pattern(level, step, name)
  const data = await checked(context)
  return data.results
    .filter((result) => !result.passed)
    .map((result) => `${result.rule}: ${result.findings.length}`)
}

// Each defect fails its rule, and its fixed twin passes every rule. In
// landscape-left the hole cutout is on the left; the bars are 24 dp.
describe.each([
  [36, 'ltr/rotation-1', 'inset-defect', ['inset: 4']],
  [36, 'ltr/rotation-1', 'inset-fixed', []],
  [36, 'ltr/rotation-1', 'sheet-defect', ['inset: 1']],
  [36, 'ltr/rotation-1', 'sheet-fixed', []],
  [36, 'ltr/rotation-1', 'overflow-defect', ['overflow: 1']],
  [36, 'ltr/rotation-1', 'overflow-fixed', []],
  [36, 'ltr/rotation-1', 'target-defect', ['touch-target: 1']],
  [36, 'ltr/rotation-1', 'target-fixed', []],
  [36, 'ltr/rotation-1', 'centred-fixed', []],
  [36, 'ltr/rotation-0', 'overflow-defect', ['overflow: 1']],
  [36, 'ltr/rotation-0', 'overflow-fixed', []],
  // In RTL the padding of the defect lands on the wrong side, and the wide
  // row runs off the left edge, under the cutout.
  [36, 'rtl/rotation-1', 'sides-defect', ['inset: 1']],
  [36, 'rtl/rotation-1', 'sides-fixed', []],
  [36, 'rtl/rotation-1', 'overflow-defect', ['inset: 1', 'overflow: 1']],
  // API 30 cuts the tree at 814.5 dp in landscape: the cut row is past it,
  // so overflow sees nothing; and a button cut there isn't too small.
  [30, 'ltr/rotation-1', 'overflow-defect', []],
  [30, 'ltr/rotation-1', 'centred-fixed', []],
  [30, 'ltr/rotation-0', 'sheet-fixed', []],
])('check on API %i, %s, %s', (level, step, name, expected) => {
  it(`fails ${expected.length ? expected.join(', ') : 'nothing'}`, async () => {
    expect(await failures(level, step, name)).toEqual(expected)
  })
})

describe('check', () => {
  it('gives each finding with its numbers', async () => {
    const { context } = pattern(36, 'ltr/rotation-1', 'overflow-defect')

    const data = await checked(context, { rules: 'overflow' })

    expect(data).toMatchObject({
      orientation: 'landscape-left',
      app: 'host.exp.exponent',
      safeAreaSource: 'probe',
      passed: false,
      results: [
        {
          rule: 'overflow',
          passed: false,
          findings: [
            {
              element: { text: 'Fifth', id: 'item-Fifth' },
              message:
                '"Fifth" is cut at the right edge of the screen: 62.48 dp shows, and its siblings are 200 dp.',
            },
          ],
        },
      ],
      warnings: [],
    })
  })

  it('reads the screen once', async () => {
    const { context, calls } = pattern(36, 'ltr/rotation-1', 'inset-fixed')

    await checked(context)

    expect(
      calls.filter((call) => call.args.includes('uiautomator')),
    ).toHaveLength(1)
  })

  it('prints each rule and each finding, and exits 1 when one fails', async () => {
    const { context } = pattern(36, 'ltr/rotation-1', 'sheet-defect')
    const out: string[] = []
    const io = {
      out: (text: string) => out.push(text),
      err: () => {},
      isTTY: true,
    }

    expect(await run(['check'], io, registry, context)).toBe(1)
    expect(out.join('\n').split('\n')).toEqual([
      'landscape-left: 914.29 × 411.43 dp (2400 × 1080 px, scale 2.625), host.exp.exponent',
      expect.stringMatching(/^inset: fail \(\d+ elements, 1 findings\)$/),
      '  "Sheet title" reaches 12.19 dp into the top inset.',
      expect.stringMatching(/^overflow: pass \(\d+ elements\)$/),
      expect.stringMatching(/^touch-target: pass \(\d+ elements\)$/),
    ])
  })

  it('exits 0 with JSON when every rule passes', async () => {
    const { context } = pattern(36, 'ltr/rotation-1', 'sheet-fixed')
    const out: string[] = []
    const io = {
      out: (text: string) => out.push(text),
      err: () => {},
      isTTY: false,
    }

    expect(await run(['check'], io, registry, context)).toBe(0)
    expect(JSON.parse(out.join(''))).toMatchObject({
      ok: true,
      data: { passed: true },
    })
  })

  it.each([
    ['an unknown rule', { rules: 'inset,centred' }],
    ['a list with a space', { rules: 'inset, overflow' }],
  ])('refuses %s', async (_name, input) => {
    const { context } = pattern(36, 'ltr/rotation-1', 'sheet-fixed')

    expect(await runCommand(registry, 'check', input, context)).toMatchObject({
      ok: false,
      error: { code: 'invalid_input' },
    })
  })
})
