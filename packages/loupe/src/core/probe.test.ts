import { describe, expect, it } from 'vitest'
import {
  describeProbe,
  isProbeLabel,
  type ProbeReport,
  readProbe,
} from './probe'

// The label of the probe app in landscape-right on API 36 (round 5).
const LABEL =
  'loupe:{"v":1,"insets":{"top":24,"right":51.80952453613281,"bottom":24,"left":0},"window":{"width":862.4761904761905,"height":363.42857142857144},"scale":2.625,"direction":"ltr","colorScheme":"light","route":"/"}'

const REPORT: ProbeReport = {
  insets: { top: 24, right: 51.80952453613281, bottom: 24, left: 0 },
  window: { width: 862.4761904761905, height: 363.42857142857144 },
  scale: 2.625,
  direction: 'ltr',
  colorScheme: 'light',
  route: '/',
}

/** The label with its JSON changed by `change`. */
function changed(change: (report: Record<string, unknown>) => void): string {
  const report = JSON.parse(LABEL.slice('loupe:'.length)) as Record<
    string,
    unknown
  >
  change(report)
  return `loupe:${JSON.stringify(report)}`
}

describe('isProbeLabel', () => {
  it.each([
    [LABEL, true],
    ['loupe:', true],
    ['Loupe: a lens', false],
    ['safe area', false],
    [undefined, false],
  ])('gives %j: %s', (label, result) => {
    expect(isProbeLabel(label)).toBe(result)
  })
})

describe('readProbe', () => {
  it('reads the report, with no format number', () => {
    expect(readProbe([LABEL])).toEqual({ report: REPORT, warnings: [] })
  })

  it('gives undefined with no label', () => {
    expect(readProbe([])).toBeUndefined()
  })

  it('reads a report with only the fields that the probe always sends', () => {
    const label = changed((report) => {
      delete report.insets
      delete report.colorScheme
      delete report.route
    })

    expect(readProbe([label])).toEqual({
      report: {
        window: REPORT.window,
        scale: 2.625,
        direction: 'ltr',
      },
      warnings: [],
    })
  })

  it('reads the first of two probes, with a warning', () => {
    const second = changed((report) => {
      report.route = '/settings'
    })

    const reading = readProbe([LABEL, second])

    expect(reading?.report?.route).toBe('/')
    expect(reading?.warnings).toEqual([
      expect.stringContaining('shows 2 probes'),
    ])
  })

  it.each([
    ['a label that is not JSON', 'loupe:{"v":1,', "isn't JSON"],
    [
      'a report with no format number',
      changed((report) => {
        delete report.v
      }),
      'no format number',
    ],
    [
      'a report of a later format',
      changed((report) => {
        report.v = 2
      }),
      'format 2, but this loupe reads only format 1',
    ],
    ['a label that is a number', 'loupe:7', 'no format number'],
    [
      'a report with a wrong field',
      changed((report) => {
        report.direction = 'up'
      }),
      'direction:',
    ],
  ])('gives a warning and no report for %s', (_name, label, words) => {
    expect(readProbe([label])).toEqual({
      warnings: [expect.stringContaining(words)],
    })
  })
})

describe('describeProbe', () => {
  it('gives one line', () => {
    expect(describeProbe(REPORT)).toBe(
      'Probe: route "/", ltr, light, window 862.48 × 363.43 dp, safe area top 24, right 51.81, bottom 24, left 0 dp',
    )
  })

  it('says when the probe gives no safe area', () => {
    expect(
      describeProbe({
        window: { width: 400, height: 800 },
        scale: 2,
        direction: 'rtl',
      }),
    ).toBe('Probe: rtl, window 400 × 800 dp, no safe area')
  })
})
