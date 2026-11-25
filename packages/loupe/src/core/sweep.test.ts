import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { type ScreenCheck } from './check'
import { type Orientation } from './display'
import { LoupeError } from './errors'
import { decodePng, encodePng, pngSize } from './png'
import {
  type DeviceLook,
  sweep,
  type SweepDriver,
  sweepReportSchema,
} from './sweep'

const out = mkdtempSync(path.join(tmpdir(), 'loupe-sweep-'))
afterAll(() => rmSync(out, { recursive: true, force: true }))

const RED = [211, 47, 47, 255]
const GREY = [117, 117, 117, 255]

function shot(width = 480, height = 960): Buffer {
  const data = new Uint8Array(width * height * 4).fill(255)
  return encodePng({ width, height, data })
}

function checkOf(orientation: Orientation, passed: boolean): ScreenCheck {
  return {
    orientation,
    size: { width: 480, height: 960 },
    pixels: { width: 480, height: 960 },
    scale: 1,
    app: 'com.example.app',
    safeAreaSource: 'dumpsys',
    passed,
    results: [
      {
        rule: 'inset',
        passed,
        checked: 3,
        findings: passed
          ? []
          : [
              {
                element: {
                  type: 'Text',
                  frame: { x: 0, y: 0, width: 1, height: 1 },
                },
                message: 'Under the bar.',
                details: {},
              },
            ],
      },
    ],
    warnings: [],
  }
}

interface Script {
  /** The links whose screen fails a rule. */
  defects?: string[]
  /** The links that give this error on the wait. */
  errors?: Record<string, LoupeError>
  /** No screenshot after an error. */
  noCapture?: boolean
  restore?: string[]
  /** The links whose screen scrolls. */
  scrolls?: string[]
  /** The links whose screen fails a rule after the scroll. */
  defectsBelow?: string[]
  /** The links that give this error on the scroll. */
  scrollErrors?: Record<string, LoupeError>
  /** What the scroll back gives: warnings, or an error. */
  back?: string[] | LoupeError
  /** The error of each restart. */
  reloadError?: LoupeError
  /** The directions whose switch stops the app. */
  restartFor?: string[]
  /** The error of the switch to each direction. */
  directionErrors?: Record<string, LoupeError>
}

function fakeDriver(
  {
    defects = [],
    errors = {},
    noCapture,
    restore = [],
    scrolls = [],
    defectsBelow = [],
    scrollErrors = {},
    back = [],
    reloadError,
    restartFor = [],
    directionErrors = {},
  }: Script = {},
  start: DeviceLook = { orientation: 'portrait', theme: 'light' },
) {
  const calls: string[] = []
  const look = { ...start }
  let url = ''
  let below = false
  const driver: SweepDriver = {
    look: async () => ({ ...start }),
    open: async (link, { cold, direction }) => {
      url = link
      calls.push(
        `open ${link}${cold ? ' cold' : ''}${cold && direction ? ` ${direction}` : ''}`,
      )
    },
    setDirection: async (direction) => {
      calls.push(`direction ${direction}`)
      const error = directionErrors[direction]
      if (error) throw error
      return { restarted: restartFor.includes(direction) }
    },
    reload: async () => {
      calls.push('reload')
      if (reloadError) throw reloadError
    },
    rotate: async (orientation) => {
      if (look.orientation !== orientation) calls.push(`rotate ${orientation}`)
      look.orientation = orientation
    },
    setTheme: async (theme) => {
      if (look.theme !== theme) calls.push(`theme ${theme}`)
      look.theme = theme
      return theme === 'dark' && url.endsWith('/fixed') ? ['Kept light.'] : []
    },
    waitStill: async () => {
      const error = errors[url]
      if (error) throw error
    },
    check: async () => ({
      check: checkOf(
        look.orientation,
        !(below ? defectsBelow : defects).includes(url),
      ),
      png: shot(),
    }),
    capture: async () => {
      if (noCapture) throw new LoupeError('app_not_in_front', 'Not in front.')
      return shot()
    },
    scroll: async () => {
      calls.push(`scroll ${url}`)
      const error = scrollErrors[url]
      if (error) throw error
      if (!scrolls.includes(url)) return undefined
      below = true
      return {
        back: async () => {
          calls.push(`back ${url}`)
          below = false
          if (back instanceof LoupeError) throw back
          return back
        },
      }
    },
    restore: async (to, changed) => {
      calls.push(
        `restore ${to.orientation} ${to.theme} ${changed.orientation} ${changed.theme}${changed.direction ? ' direction' : ''}`,
      )
      return restore
    },
  }
  return { driver, calls }
}

function pixel(file: string, x: number, y: number): number[] {
  const image = decodePng(readFileSync(file))
  return [...image.data.subarray((y * image.width + x) * 4).subarray(0, 4)]
}

const A = 'app://a'
const B = 'app://b'

describe('sweep', () => {
  it('checks each link in the look of the device, and changes nothing', async () => {
    const folder = path.join(out, 'plain')
    const { driver, calls } = fakeDriver({ defects: [B] })

    const report = await sweep(driver, { urls: [A, B], out: folder })

    expect(calls).toEqual([
      `open ${A}`,
      `open ${B}`,
      'restore portrait light false false',
    ])
    expect(report.variants[0]).not.toHaveProperty('scrolledSheet')
    expect(report).toMatchObject({
      out: folder,
      passed: false,
      variants: [
        {
          name: 'portrait-light',
          orientation: 'portrait',
          theme: 'light',
          sheet: path.join(folder, 'portrait-light.png'),
          screens: 2,
          failed: 1,
        },
      ],
      screens: [
        {
          number: 1,
          url: A,
          variant: 'portrait-light',
          passed: true,
          screenshot: path.join(folder, 'portrait-light', '01.png'),
        },
        { number: 2, url: B, passed: false, check: { passed: false } },
      ],
      warnings: [],
    })
    expect(pngSize(readFileSync(report.screens[1]?.screenshot ?? ''))).toEqual({
      width: 480,
      height: 960,
    })
  })

  it('writes the report as report.json', async () => {
    const folder = path.join(out, 'report')
    const { driver } = fakeDriver({ defects: [A] })

    const report = await sweep(driver, { urls: [A], out: folder })
    const saved: unknown = JSON.parse(
      readFileSync(path.join(folder, 'report.json'), 'utf8'),
    )

    expect(sweepReportSchema.parse(saved)).toEqual(report)
    expect(report.screens[0]?.check?.results[0]?.findings).toHaveLength(1)
  })

  it('crosses the orientations with the themes, and puts both back', async () => {
    const folder = path.join(out, 'variants')
    const { driver, calls } = fakeDriver()

    const report = await sweep(driver, {
      urls: [A, B],
      orientations: ['portrait', 'landscape-left'],
      themes: ['light', 'dark'],
      out: folder,
    })

    expect(report.variants.map(({ name }) => name)).toEqual([
      'portrait-light',
      'portrait-dark',
      'landscape-left-light',
      'landscape-left-dark',
    ])
    expect(report.screens).toHaveLength(8)
    expect(report.passed).toBe(true)
    // Each change comes after the first link of its variant is open.
    expect(calls).toEqual([
      `open ${A}`,
      `open ${B}`,
      `open ${A}`,
      'theme dark',
      `open ${B}`,
      `open ${A}`,
      'rotate landscape-left',
      'theme light',
      `open ${B}`,
      `open ${A}`,
      'theme dark',
      `open ${B}`,
      'restore portrait light true true',
    ])
  })

  it('keeps the error of a screen, and goes on with the next one', async () => {
    const folder = path.join(out, 'errors')
    const { driver } = fakeDriver({
      errors: {
        [A]: new LoupeError('timeout', "The screen didn't keep still."),
      },
    })

    const report = await sweep(driver, { urls: [A, B], out: folder })

    expect(report.passed).toBe(false)
    expect(report.screens[0]).toMatchObject({
      passed: false,
      error: { code: 'timeout', message: "The screen didn't keep still." },
      screenshot: path.join(folder, 'portrait-light', '01.png'),
    })
    expect(report.screens[0]?.check).toBeUndefined()
    expect(report.screens[1]).toMatchObject({ number: 2, passed: true })
    expect(report.variants[0]).toMatchObject({ screens: 2, failed: 1 })
  })

  it('draws a red cell for a failed screen, also with no screenshot', async () => {
    const folder = path.join(out, 'sheet')
    const { driver } = fakeDriver({
      errors: { [A]: new LoupeError('no_handler', 'No app opens it.') },
      noCapture: true,
    })

    const report = await sweep(driver, { urls: [A, B], out: folder })
    const sheet = report.variants[0]?.sheet ?? ''

    expect(report.screens[0]?.screenshot).toBeUndefined()
    // Two 240 × 480 thumbnails with a 4 px frame, 8 px apart.
    expect(pngSize(readFileSync(sheet))).toEqual({ width: 520, height: 504 })
    expect(pixel(sheet, 8 + 247, 8 + 487)).toEqual(RED)
    expect(pixel(sheet, 8 + 124, 8 + 244)).toEqual([0, 0, 0, 255])
    expect(pixel(sheet, 264 + 247, 8 + 487)).toEqual(GREY)
    expect(pixel(sheet, 264 + 124, 8 + 244)).toEqual([255, 255, 255, 255])
  })

  it('keeps the warnings of a screen, and of the restore', async () => {
    const { driver } = fakeDriver({ restore: ['The theme stays dark.'] })

    const report = await sweep(driver, {
      urls: ['app://sides/fixed'],
      themes: ['dark'],
      out: path.join(out, 'warnings'),
    })

    expect(report.screens[0]?.warnings).toEqual(['Kept light.'])
    expect(report.warnings).toEqual(['The theme stays dark.'])
    expect(report.variants[0]?.theme).toBe('dark')
  })

  it('names the variant by a setting that is not a theme', async () => {
    const { driver } = fakeDriver(
      {},
      { orientation: 'landscape-right', theme: 'auto' },
    )

    const report = await sweep(driver, {
      urls: [A],
      out: path.join(out, 'auto'),
    })

    expect(report.variants[0]?.name).toBe('landscape-right-auto')
  })

  it('puts the look back when a call fails with no loupe error', async () => {
    const { driver, calls } = fakeDriver()
    driver.check = async () => {
      throw new TypeError('broken')
    }

    await expect(
      sweep(driver, {
        urls: [A],
        orientations: ['landscape-left'],
        out: path.join(out, 'broken'),
      }),
    ).rejects.toThrow('broken')
    expect(calls.at(-1)).toBe('restore portrait light true false')
  })

  it('numbers the files with 3 digits from 100 links', async () => {
    const folder = path.join(out, 'many')
    const urls = Array.from({ length: 100 }, (_, index) => `app://s/${index}`)
    const { driver } = fakeDriver()
    driver.check = async () => ({
      check: checkOf('portrait', true),
      png: shot(24, 48),
    })

    const report = await sweep(driver, { urls, out: folder })

    expect(report.screens[0]?.screenshot).toBe(
      path.join(folder, 'portrait-light', '001.png'),
    )
    expect(report.screens[99]?.screenshot).toBe(
      path.join(folder, 'portrait-light', '100.png'),
    )
  })

  it('checks each screen again after one scroll down, and scrolls back', async () => {
    const folder = path.join(out, 'scroll')
    const { driver, calls } = fakeDriver({ scrolls: [A], defectsBelow: [A] })

    const report = await sweep(driver, {
      urls: [A, B],
      out: folder,
      scroll: true,
    })

    expect(calls).toEqual([
      `open ${A}`,
      `scroll ${A}`,
      `back ${A}`,
      `open ${B}`,
      `scroll ${B}`,
      'restore portrait light false false',
    ])
    expect(report.screens).toMatchObject([
      {
        number: 1,
        url: A,
        scrolled: false,
        passed: true,
        screenshot: path.join(folder, 'portrait-light', '01.png'),
      },
      {
        number: 1,
        url: A,
        scrolled: true,
        passed: false,
        check: { passed: false },
        screenshot: path.join(folder, 'portrait-light', '01-scrolled.png'),
        warnings: [],
      },
      { number: 2, url: B, scrolled: false, passed: true },
    ])
    expect(report.passed).toBe(false)
    expect(report.variants).toEqual([
      expect.objectContaining({
        sheet: path.join(folder, 'portrait-light.png'),
        scrolledSheet: path.join(folder, 'portrait-light-scrolled.png'),
        screens: 3,
        failed: 1,
      }),
    ])
    // One 240 × 480 thumbnail in a red frame: only link 1 scrolled.
    const sheet = report.variants[0]?.scrolledSheet ?? ''
    expect(pngSize(readFileSync(sheet))).toEqual({ width: 264, height: 504 })
    expect(pixel(sheet, 8 + 247, 8 + 487)).toEqual(RED)
  })

  it('keeps the error of a scroll, and the warnings of the way back', async () => {
    const { driver } = fakeDriver({
      scrolls: [B],
      scrollErrors: {
        [A]: new LoupeError('not_idle', 'The screen never kept still.'),
      },
      back: ['The top did not come back.'],
    })

    const report = await sweep(driver, {
      urls: [A, B],
      out: path.join(out, 'scroll-errors'),
      scroll: true,
    })

    expect(report.screens).toMatchObject([
      { url: A, scrolled: false, passed: true },
      {
        url: A,
        scrolled: true,
        passed: false,
        error: { code: 'not_idle', message: 'The screen never kept still.' },
        screenshot: expect.stringMatching(/01-scrolled\.png$/),
      },
      { url: B, scrolled: false, passed: true },
      {
        url: B,
        scrolled: true,
        passed: true,
        warnings: ['The top did not come back.'],
      },
    ])
  })

  it('warns when loupe could not scroll back to the top', async () => {
    const { driver } = fakeDriver({
      scrolls: [A],
      back: new LoupeError('app_not_in_front', 'Another app is in front.'),
    })

    const report = await sweep(driver, {
      urls: [A],
      out: path.join(out, 'scroll-back'),
      scroll: true,
    })

    expect(report.screens[1]?.warnings).toEqual([
      "loupe couldn't scroll back to the top, so the next check of this link can start lower down: Another app is in front.",
    ])
  })

  it('scrolls no screen that loupe could not open', async () => {
    const { driver, calls } = fakeDriver({
      scrolls: [A],
      errors: {
        [A]: new LoupeError('timeout', "The screen didn't keep still."),
      },
    })

    const report = await sweep(driver, {
      urls: [A],
      out: path.join(out, 'scroll-none'),
      scroll: true,
    })

    expect(calls).not.toContain(`scroll ${A}`)
    expect(report.screens).toHaveLength(1)
    expect(report.variants[0]).not.toHaveProperty('scrolledSheet')
  })
})

describe('sweep, progress and cancel', () => {
  it('stops the app before each N-th link, over the variants', async () => {
    const C = 'app://c'
    const { driver, calls } = fakeDriver()

    const report = await sweep(driver, {
      urls: [A, B, C],
      orientations: ['portrait', 'landscape-left'],
      out: path.join(out, 'reload'),
      reloadEvery: 2,
    })

    expect(calls).toEqual([
      `open ${A}`,
      `open ${B}`,
      'reload',
      `open ${C} cold`,
      `open ${A}`,
      'rotate landscape-left',
      'reload',
      `open ${B} cold`,
      `open ${C}`,
      'restore portrait light true false',
    ])
    expect(report.screens.map((screen) => screen.reloaded)).toEqual([
      false,
      false,
      true,
      false,
      true,
      false,
    ])
  })

  it('keeps a failed restart as the error of its screen, and goes on', async () => {
    const { driver, calls } = fakeDriver({
      reloadError: new LoupeError('tool_failed', 'am force-stop failed.'),
    })

    const report = await sweep(driver, {
      urls: [A, B],
      out: path.join(out, 'reload-error'),
      reloadEvery: 1,
    })

    expect(calls).toEqual([
      `open ${A}`,
      'reload',
      'restore portrait light false false',
    ])
    expect(report.screens[1]).toMatchObject({
      url: B,
      reloaded: true,
      passed: false,
      error: { code: 'tool_failed' },
    })
  })

  it('sets each direction once, before its variants, and opens cold after a switch', async () => {
    const { driver, calls } = fakeDriver({ restartFor: ['rtl'] })

    const report = await sweep(driver, {
      urls: [A, B],
      orientations: ['portrait', 'landscape-left'],
      directions: ['ltr', 'rtl'],
      out: path.join(out, 'directions'),
    })

    expect(calls).toEqual([
      'direction ltr',
      `open ${A}`,
      `open ${B}`,
      `open ${A}`,
      'rotate landscape-left',
      `open ${B}`,
      'direction rtl',
      `open ${A} cold rtl`,
      'rotate portrait',
      `open ${B}`,
      `open ${A}`,
      'rotate landscape-left',
      `open ${B}`,
      'restore portrait light true false direction',
    ])
    expect(
      report.variants.map(({ name, direction }) => [name, direction]),
    ).toEqual([
      ['portrait-light-ltr', 'ltr'],
      ['landscape-left-light-ltr', 'ltr'],
      ['portrait-light-rtl', 'rtl'],
      ['landscape-left-light-rtl', 'rtl'],
    ])
    expect(report.screens.map((screen) => screen.variant)).toContain(
      'landscape-left-light-rtl',
    )
  })

  it('puts the look back and gives the error when a direction fails', async () => {
    const { driver, calls } = fakeDriver({
      directionErrors: {
        rtl: new LoupeError('unsupported', 'No app.json.'),
      },
    })

    await expect(
      sweep(driver, {
        urls: [A],
        directions: ['ltr', 'rtl'],
        out: path.join(out, 'direction-error'),
      }),
    ).rejects.toMatchObject({ code: 'unsupported' })
    expect(calls).toEqual([
      'direction ltr',
      `open ${A}`,
      'direction rtl',
      'restore portrait light false false direction',
    ])
  })

  it('gives the progress after each link of each variant', async () => {
    const { driver } = fakeDriver({ defects: [B], scrolls: [A] })
    const updates: unknown[] = []

    await sweep(
      driver,
      {
        urls: [A, B],
        orientations: ['portrait', 'landscape-left'],
        out: path.join(out, 'progress'),
        scroll: true,
      },
      { progress: (update) => updates.push(update) },
    )

    expect(updates).toEqual([
      {
        progress: 1,
        total: 4,
        message: 'portrait-light, link 1 of 2: passed; scrolled: passed',
      },
      { progress: 2, total: 4, message: 'portrait-light, link 2 of 2: failed' },
      {
        progress: 3,
        total: 4,
        message: 'landscape-left-light, link 1 of 2: passed; scrolled: passed',
      },
      {
        progress: 4,
        total: 4,
        message: 'landscape-left-light, link 2 of 2: failed',
      },
    ])
  })

  it('stops before the next link when the call is cancelled, and puts the look back', async () => {
    const folder = path.join(out, 'cancelled')
    const { driver, calls } = fakeDriver()
    const controller = new AbortController()

    const swept = sweep(
      driver,
      { urls: [A, B], orientations: ['landscape-left'], out: folder },
      { signal: controller.signal, progress: () => controller.abort() },
    )

    await expect(swept).rejects.toMatchObject({
      code: 'cancelled',
      message: expect.stringContaining('after 1 of 2 screens'),
    })
    expect(calls).toEqual([
      `open ${A}`,
      'rotate landscape-left',
      'restore portrait light true false',
    ])
    expect(() => readFileSync(path.join(folder, 'report.json'))).toThrow()
  })

  it('stops at a cancel inside a screen, and keeps it out of the report', async () => {
    const { driver, calls } = fakeDriver({
      errors: { [A]: new LoupeError('cancelled', 'The call was cancelled.') },
    })

    await expect(
      sweep(driver, { urls: [A, B], out: path.join(out, 'cancel-inside') }),
    ).rejects.toMatchObject({ code: 'cancelled' })
    expect(calls).toEqual([`open ${A}`, 'restore portrait light false false'])
  })
})
