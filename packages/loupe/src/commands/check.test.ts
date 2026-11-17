import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { run } from '../cli/run'
import { type CommandContext } from '../core/context'
import { encodePng } from '../core/png'
import { runCommand } from '../core/run-command'
import { byCommand, fakeContext, type FakeRun } from '../testing/fake-exec'
import { recorded } from '../testing/fixtures'
import { checkCommand } from './check'
import { registry } from './index'

const ADB = 'adb -s emulator-5554'

/**
 * One screen of the probe app's patterns, from recorder round 6: the hole
 * cutout is on, `step` is the direction and the rotation. The recorder took
 * the screenshot right after the dump.
 */
function pattern(
  level: number,
  step: string,
  name: string,
  screenshot: FakeRun = recorded(`api-${level}/check/${step}/${name}.png`),
) {
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
      [`${ADB} exec-out screencap -p`]: screenshot,
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
  [36, 'ltr/rotation-1', 'centred-defect', ['centred: 1']],
  [36, 'ltr/rotation-1', 'centred-fixed', []],
  [36, 'ltr/rotation-0', 'overflow-defect', ['overflow: 1']],
  [36, 'ltr/rotation-0', 'overflow-fixed', []],
  [36, 'ltr/rotation-0', 'centred-defect', ['centred: 1']],
  [36, 'ltr/rotation-0', 'centred-fixed', []],
  // In RTL the padding of the defect lands on the wrong side, and the wide
  // row runs off the left edge, under the cutout.
  [36, 'rtl/rotation-1', 'sides-defect', ['inset: 1']],
  [36, 'rtl/rotation-1', 'sides-fixed', []],
  [36, 'rtl/rotation-1', 'overflow-defect', ['inset: 1', 'overflow: 1']],
  [36, 'rtl/rotation-1', 'centred-defect', ['centred: 1']],
  [36, 'rtl/rotation-1', 'centred-fixed', []],
  // API 30 cuts the tree at 814.5 dp in landscape: the cut row is past it,
  // so overflow sees nothing; a button cut there isn't too small; and the
  // bar ends there, so its centre is unknown.
  [30, 'ltr/rotation-1', 'overflow-defect', []],
  [30, 'ltr/rotation-1', 'centred-defect', []],
  [30, 'ltr/rotation-1', 'centred-fixed', []],
  [30, 'ltr/rotation-0', 'sheet-fixed', []],
  [30, 'ltr/rotation-0', 'centred-defect', ['centred: 1']],
  [30, 'ltr/rotation-0', 'centred-fixed', []],
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

  it('gives the numbers of a title off centre', async () => {
    const { context } = pattern(36, 'ltr/rotation-1', 'centred-defect')

    const data = await checked(context, { rules: 'centred' })

    // The bar spans the safe area: 51.81–914.29 dp. The title's frame fills
    // the space between the back button and the actions; its text is
    // centred in that frame.
    expect(data.results).toEqual([
      {
        rule: 'centred',
        passed: false,
        checked: 1,
        findings: [
          {
            element: expect.objectContaining({ id: 'bar-title' }),
            message:
              '"Centred title" sits between label "Back" and label "Search", clear of both, but 47.43 dp left of the centre of its container, #bar.',
            details: {
              offCentre: expect.closeTo(-47.43, 2),
              centre: expect.closeTo(435.62, 2),
              containerCentre: expect.closeTo(483.05, 2),
              leftGap: expect.closeTo(282.29, 2),
              rightGap: expect.closeTo(281.14, 2),
            },
          },
        ],
      },
    ])
  })

  it('checks a named element where it sits near an end', async () => {
    // In portrait the centred title ends within 24 dp of the actions, so
    // only a named check looks at it.
    const { context } = pattern(36, 'ltr/rotation-0', 'centred-fixed')

    const plain = await checked(context, { rules: 'centred' })
    const named = await checked(context, {
      rules: 'centred',
      centredId: ['bar-title'],
    })

    expect(plain.results[0]).toMatchObject({ passed: true, checked: 0 })
    expect(named.results[0]).toMatchObject({ passed: true, checked: 1 })
  })

  it('reads the screen once, and takes a screenshot only for centred', async () => {
    const all = pattern(36, 'ltr/rotation-1', 'inset-fixed')
    const some = pattern(36, 'ltr/rotation-1', 'inset-fixed')

    await checked(all.context)
    await checked(some.context, { rules: 'inset,touch-target' })

    const count = (calls: typeof all.calls, tool: string) =>
      calls.filter((call) => call.args.includes(tool)).length
    expect(count(all.calls, 'uiautomator')).toBe(1)
    expect(count(all.calls, 'screencap')).toBe(1)
    expect(count(some.calls, 'screencap')).toBe(0)
  })

  it('fails when the screen changed size between the tree and the screenshot', async () => {
    const small = { width: 24, height: 10, data: new Uint8Array(24 * 10 * 4) }
    const { context } = pattern(36, 'ltr/rotation-1', 'inset-fixed', {
      stdout: encodePng(small),
    })

    expect(await runCommand(registry, 'check', {}, context)).toMatchObject({
      ok: false,
      error: {
        code: 'not_idle',
        message: expect.stringContaining('(2400 × 1080 px, then 24 × 10 px)'),
      },
    })
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
      'centred: pass (0 elements)',
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
    ['an unknown rule', { rules: 'inset,centered' }],
    ['a list with a space', { rules: 'inset, overflow' }],
    [
      'a centred element with no centred rule',
      { rules: 'inset', centredId: ['bar-title'] },
    ],
    ['an empty centred text', { centred: [''] }],
  ])('refuses %s', async (_name, input) => {
    const { context } = pattern(36, 'ltr/rotation-1', 'sheet-fixed')

    expect(await runCommand(registry, 'check', input, context)).toMatchObject({
      ok: false,
      error: { code: 'invalid_input' },
    })
  })
})

describe('check --mirror-of', () => {
  const folder = mkdtempSync(path.join(tmpdir(), 'loupe-check-'))
  afterAll(() => rmSync(folder, { recursive: true, force: true }))

  // These runs need no screenshot: only `centred` takes one.
  const NO_SHOT: FakeRun = { code: 1, stderr: 'No screenshot in this test.' }

  /** Saves `ui` of a screen as `loupe ui --json > file` does. */
  async function saved(step: string, name: string, data = false) {
    const { context } = pattern(36, step, name, NO_SHOT)
    const result = await runCommand(registry, 'ui', {}, context)
    const file = path.join(folder, `${step.replace('/', '-')}-${name}.json`)
    writeFileSync(
      file,
      JSON.stringify(data && result.ok ? result.data : result),
    )
    return file
  }

  async function mirrored(step: string, name: string, mirrorOf: string) {
    const { context } = pattern(36, step, name, NO_SHOT)
    const data = await checked(context, { rules: 'mirrored', mirrorOf })
    return data.results[0]
  }

  // Landscape-left, hole cutout on the left: the safe area is 51.81–914.29
  // dp, so LTR's 63.62–199.62 dp mirrors to 766.48–902.48 dp.
  it('finds a menu that RTL opens on the side where LTR opens it', async () => {
    const ltr = await saved('ltr/rotation-1', 'mirrored-defect')

    expect(await mirrored('rtl/rotation-1', 'mirrored-defect', ltr)).toEqual({
      rule: 'mirrored',
      passed: false,
      checked: 5,
      findings: ['Edit', 'Delete'].map((text) => ({
        element: expect.objectContaining({ text }),
        message: `"${text}" sits at 11.81–147.81 dp in RTL. LTR puts it at 63.62–199.62 dp, so mirrored it belongs at 766.48–902.48 dp.`,
        details: {
          from: expect.closeTo(11.81, 2),
          to: expect.closeTo(147.81, 2),
          expectedFrom: expect.closeTo(766.48, 2),
          expectedTo: expect.closeTo(902.48, 2),
          referenceFrom: expect.closeTo(63.62, 2),
          referenceTo: expect.closeTo(199.62, 2),
        },
      })),
    })
  })

  it('passes the fixed menu, and finds side padding on the wrong side', async () => {
    const menu = await saved('ltr/rotation-1', 'mirrored-fixed')
    const sides = await saved('ltr/rotation-1', 'sides-defect')

    expect(
      await mirrored('rtl/rotation-1', 'mirrored-fixed', menu),
    ).toMatchObject({ passed: true, checked: 5 })
    expect(
      (await mirrored('rtl/rotation-1', 'sides-defect', sides))?.findings,
    ).toMatchObject([{ element: { text: 'Lead' } }])
  })

  it('takes LTR as the reference from either side, and the data alone', async () => {
    const rtl = await saved('rtl/rotation-1', 'mirrored-defect', true)

    const result = await mirrored('ltr/rotation-1', 'mirrored-defect', rtl)

    expect(result?.findings.map((finding) => finding.message)).toEqual([
      '"Edit" sits at 11.81–147.81 dp in RTL. LTR puts it at 63.62–199.62 dp, so mirrored it belongs at 766.48–902.48 dp.',
      '"Delete" sits at 11.81–147.81 dp in RTL. LTR puts it at 63.62–199.62 dp, so mirrored it belongs at 766.48–902.48 dp.',
    ])
  })

  it('adds mirrored to the rules by default', async () => {
    const ltr = await saved('ltr/rotation-1', 'mirrored-defect')
    const { context } = pattern(36, 'rtl/rotation-1', 'mirrored-defect')

    const data = await checked(context, { mirrorOf: ltr })

    expect(data.results.map((result) => result.rule)).toEqual([
      'inset',
      'overflow',
      'centred',
      'touch-target',
      'mirrored',
    ])
  })

  it.each([
    [
      'the mirrored rule with no file',
      async () => ({ rules: 'mirrored' }),
      'The mirrored rule needs --mirror-of',
    ],
    [
      'a file with no mirrored rule',
      async () => ({
        rules: 'inset',
        mirrorOf: await saved('ltr/rotation-1', 'mirrored-defect'),
      }),
      'The mirror-of file needs the mirrored rule.',
    ],
    [
      'a file that is not there',
      async () => ({ mirrorOf: path.join(folder, 'none.json') }),
      'There is no file',
    ],
    [
      'a file that is not JSON',
      async () => {
        const file = path.join(folder, 'text.json')
        writeFileSync(file, 'landscape')
        return { mirrorOf: file }
      },
      "text.json isn't JSON.",
    ],
    [
      'a file that is not the output of ui',
      async () => {
        const file = path.join(folder, 'other.json')
        writeFileSync(file, JSON.stringify({ ok: true, data: { nodes: [] } }))
        return { mirrorOf: file }
      },
      "other.json isn't the output of loupe ui.",
    ],
    [
      'a screen in another orientation',
      async () => ({
        mirrorOf: await saved('ltr/rotation-0', 'centred-fixed'),
      }),
      'The saved screen is portrait',
    ],
    [
      'another route',
      async () => ({
        mirrorOf: await saved('ltr/rotation-1', 'centred-fixed'),
      }),
      'The saved screen shows /centred/fixed, and this one shows /mirrored/defect.',
    ],
    [
      'a screen in the same direction',
      async () => ({
        mirrorOf: await saved('rtl/rotation-1', 'mirrored-defect'),
      }),
      'Both screens are RTL.',
    ],
  ])('refuses %s', async (_name, input, message) => {
    const { context } = pattern(36, 'rtl/rotation-1', 'mirrored-defect')

    expect(
      await runCommand(registry, 'check', await input(), context),
    ).toMatchObject({
      ok: false,
      error: {
        code: 'invalid_input',
        message: expect.stringContaining(message),
      },
    })
  })
})
