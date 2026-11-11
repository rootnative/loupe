import { describe, expect, it } from 'vitest'
import {
  encodeProbeReport,
  PROBE_FORMAT,
  PROBE_PREFIX,
  type ProbeReport,
} from './report'

const report: ProbeReport = {
  insets: { top: 0, right: 59, bottom: 21, left: 59 },
  window: { width: 852, height: 393 },
  scale: 3,
  direction: 'ltr',
  colorScheme: 'dark',
  route: '/settings',
}

function decode(label: string): unknown {
  return JSON.parse(label.slice(PROBE_PREFIX.length))
}

describe('encodeProbeReport', () => {
  it('starts with the prefix and carries the report as JSON', () => {
    const label = encodeProbeReport(report)

    expect(label.startsWith('loupe:{')).toBe(true)
    expect(decode(label)).toEqual({ v: PROBE_FORMAT, ...report })
  })

  it('leaves the route out when the app does not pass it', () => {
    const { route: _route, ...rest } = report

    expect(decode(encodeProbeReport(rest))).toEqual({
      v: PROBE_FORMAT,
      ...rest,
    })
  })

  it('carries only the report fields of a larger object', () => {
    const larger = {
      ...report,
      token: 'secret',
      insets: { ...report.insets, frame: { x: 0 } },
    }

    expect(decode(encodeProbeReport(larger))).toEqual({
      v: PROBE_FORMAT,
      ...report,
    })
  })

  it('gives one line', () => {
    expect(encodeProbeReport(report)).not.toMatch(/\s/)
  })
})
