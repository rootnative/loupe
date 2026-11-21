import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { run } from '../cli/run'
import { pngSize } from '../core/png'
import { runCommand } from '../core/run-command'
import { sweepReportSchema } from '../core/sweep'
import { byCommand, fakeContext } from '../testing/fake-exec'
import { recorded } from '../testing/fixtures'
import { registry } from './index'
import { sweepCommand } from './sweep'

const ADB = 'adb -s emulator-5554'
const STEP = 'api-36/check/ltr/rotation-0'
const out = mkdtempSync(path.join(tmpdir(), 'loupe-sweep-command-'))
afterAll(() => rmSync(out, { recursive: true, force: true }))

const link = (name: string) => `exp://127.0.0.1:8081/--/${name}`

/**
 * The probe app's patterns of recorder round 6 on API 36, in portrait: a
 * link shows the screen of its pattern, and the screenshot never changes,
 * so the screen keeps still.
 */
function emulator() {
  let shown = ''
  const fixed = byCommand({
    'adb devices -l': recorded('api-36/host/adb-devices-l.txt'),
    [`${ADB} shell getprop`]: recorded('api-36/device/getprop.txt'),
    [`${ADB} shell dumpsys window displays`]: recorded(
      `${STEP}/dumpsys-window-displays.txt`,
    ),
    [`${ADB} shell cmd uimode night`]: recorded(
      'api-36/probe/device/uimode-night-at-start.txt',
    ),
  })
  return fakeContext((call) => {
    const args = call.args.slice(2).join(' ')
    const opened = /^shell am start .* -d '.*\/--\/(\S+)'$/.exec(args)
    if (opened) {
      shown = opened[1]?.replace('/', '-') ?? ''
      return recorded('api-36/extra/am-start-https.txt')
    }
    if (args === 'exec-out uiautomator dump /dev/tty') {
      return recorded(`${STEP}/${shown}.ui-tty.txt`)
    }
    if (args === 'exec-out screencap -p') {
      return recorded(`${STEP}/${shown}.png`)
    }
    return fixed(call)
  })
}

async function swept(input: object) {
  const { context, calls } = emulator()
  const result = await runCommand(registry, 'sweep', input, context)
  if (!result.ok) throw new Error(result.error.message)
  return { data: sweepCommand.output.parse(result.data), calls }
}

// Each sweep decodes and checks recorded screenshots of 1080 × 2400 px. That
// takes more than the default 5 s while other test files run at the same time.
describe('sweep', { timeout: 30_000 }, () => {
  it('finds the defects of the patterns, and passes their fixed twins', async () => {
    const folder = path.join(out, 'patterns')
    const { data, calls } = await swept({
      url: [
        link('centred/defect'),
        link('centred/fixed'),
        link('overflow/defect'),
        link('overflow/fixed'),
      ],
      out: folder,
    })

    expect(data).toMatchObject({
      out: folder,
      report: path.join(folder, 'report.json'),
      passed: false,
      screens: 4,
      failed: 2,
      variants: [
        {
          name: 'portrait-light',
          sheet: path.join(folder, 'portrait-light.png'),
          screens: 4,
          failed: 2,
        },
      ],
      failures: [
        {
          number: 1,
          url: link('centred/defect'),
          variant: 'portrait-light',
          screenshot: path.join(folder, 'portrait-light', '01.png'),
          rules: ['centred'],
          findings: 1,
        },
        { number: 3, rules: ['overflow'], findings: 1 },
      ],
      warnings: [],
    })
    // Nothing written to the device: no rotation, no theme.
    expect(
      calls
        .map((call) => call.args.slice(2).join(' '))
        .filter((args) =>
          /settings put|uimode night \w|user-rotation/.test(args),
        ),
    ).toEqual([])

    const report = sweepReportSchema.parse(
      JSON.parse(readFileSync(data.report, 'utf8')),
    )
    expect(report.screens.map((screen) => screen.passed)).toEqual([
      false,
      true,
      false,
      true,
    ])
    expect(report.screens[2]?.check?.results).toContainEqual(
      expect.objectContaining({ rule: 'overflow', passed: false }),
    )
    // 4 thumbnails of 240 × 533 px in one row.
    expect(pngSize(readFileSync(data.variants[0]?.sheet ?? ''))).toEqual({
      width: 8 + 4 * 256,
      height: 8 + 541 + 8,
    })
    expect(pngSize(readFileSync(report.screens[3]?.screenshot ?? ''))).toEqual({
      width: 1080,
      height: 2400,
    })
  })

  it('runs only the rules of the list', async () => {
    const { data } = await swept({
      url: [link('centred/defect')],
      rules: 'inset,overflow',
      out: path.join(out, 'rules'),
    })

    expect(data).toMatchObject({ passed: true, screens: 1, failed: 0 })
  })

  it.each([
    [{ rules: 'mirrored' }, 'A sweep runs in one layout direction'],
    [{ orientation: 'portrait,sideways' }, '"sideways" isn\'t an orientation'],
    [{ theme: 'auto' }, '"auto" isn\'t a theme. Use: light, dark.'],
  ])('refuses %o before it opens a link', async (input, message) => {
    const { context, calls } = emulator()

    const result = await runCommand(
      registry,
      'sweep',
      {
        url: [link('centred/fixed')],
        out: path.join(out, 'refused'),
        ...input,
      },
      context,
    )

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'invalid_input',
        message: expect.stringContaining(message),
      },
    })
    expect(calls).toEqual([])
  })

  it('exits with 1 when a screen fails, and with 0 when each one passes', async () => {
    const lines: string[] = []
    const io = {
      out: (text: string) => lines.push(text),
      err: (text: string) => lines.push(text),
      isTTY: true,
    }
    const args = (name: string) => [
      'sweep',
      '--url',
      link(name),
      '--out',
      path.join(out, 'cli'),
    ]

    expect(
      await run(args('overflow/defect'), io, registry, emulator().context),
    ).toBe(1)
    expect(lines.join('\n')).toContain('1 of 1 screens failed.')
    expect(lines.join('\n')).toContain(
      `  1 portrait-light ${link('overflow/defect')}: overflow (1 findings)`,
    )
    expect(
      await run(args('overflow/fixed'), io, registry, emulator().context),
    ).toBe(0)
    expect(lines.join('\n')).toContain('1 screens, each one passed.')
  })

  it('checks no screen twice with scroll when no vertical scroll view shows', async () => {
    const { data, calls } = await swept({
      url: [link('overflow/defect'), link('centred/fixed')],
      scroll: true,
      out: path.join(out, 'scroll'),
    })

    // The overflow pattern has a horizontal scroll view only.
    expect(data).toMatchObject({ screens: 2, failed: 1 })
    expect(data.variants[0]).not.toHaveProperty('scrolledSheet')
    expect(
      calls.filter(
        (call) => call.args[2] === 'emu' || call.args[3] === 'input',
      ),
    ).toEqual([])
  })

  it('names a scrolled screen and its contact sheet in the summary', () => {
    const text = sweepCommand.format?.(
      sweepCommand.output.parse({
        out: '/tmp/s',
        report: '/tmp/s/report.json',
        passed: false,
        screens: 2,
        failed: 1,
        variants: [
          {
            name: 'portrait-light',
            orientation: 'portrait',
            theme: 'light',
            sheet: '/tmp/s/portrait-light.png',
            scrolledSheet: '/tmp/s/portrait-light-scrolled.png',
            screens: 2,
            failed: 1,
          },
        ],
        failures: [
          {
            number: 1,
            url: 'app://a',
            variant: 'portrait-light',
            scrolled: true,
            rules: ['touch-target'],
            findings: 1,
          },
        ],
        warnings: [],
      }),
    )

    expect(text).toContain(
      'portrait-light: 1 failed, contact sheet /tmp/s/portrait-light.png, scrolled /tmp/s/portrait-light-scrolled.png',
    )
    expect(text).toContain(
      '  1 portrait-light scrolled app://a: touch-target (1 findings)',
    )
  })
})
