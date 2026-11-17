import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { run } from '../cli/run'
import { cropImage, decodePng } from '../core/png'
import { runCommand } from '../core/run-command'
import { byCommand, type FakeRun, fakeContext } from '../testing/fake-exec'
import { recorded } from '../testing/fixtures'
import { pngHeader } from '../testing/png'
import { registry } from './index'

const ADB = 'adb -s emulator-5554'
const SETTINGS = recorded('api-36/none/rotation-1/settings.png')

function emulator36(screencap: FakeRun | readonly FakeRun[] = SETTINGS) {
  return fakeContext(
    byCommand({
      'adb devices -l': recorded('api-36/host/adb-devices-l.txt'),
      [`${ADB} shell getprop`]: recorded('api-36/device/getprop.txt'),
      [`${ADB} shell dumpsys window displays`]: recorded(
        'api-36/none/rotation-1/settings/dumpsys-window-displays.txt',
      ),
      [`${ADB} exec-out screencap -p`]: screencap,
    }),
  )
}

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'loupe-screenshot-'))
})

afterEach(() => rm(dir, { recursive: true, force: true }))

describe('screenshot', () => {
  it('writes the PNG, makes its folder, and gives the size in px and dp', async () => {
    const { context } = emulator36()
    const out = path.join(dir, 'shots', 'settings.png')

    expect(await runCommand(registry, 'screenshot', { out }, context)).toEqual({
      ok: true,
      command: 'screenshot',
      data: {
        file: out,
        orientation: 'landscape-left',
        size: { width: 2400 / 2.625, height: 1080 / 2.625 },
        pixels: { width: 2400, height: 1080 },
        scale: 2.625,
        image: { width: 2400, height: 1080 },
      },
    })
    expect(await readFile(out)).toEqual(SETTINGS.stdout)
  })

  it('crops in dp and scales down, from the decoded screen', async () => {
    const { context } = emulator36()
    const out = path.join(dir, 'crop.png')

    const result = await runCommand(
      registry,
      'screenshot',
      { out, crop: '0,0,100,50', scale: 0.5 },
      context,
    )

    // 100 × 50 dp is 262.5 × 131.25 px, so the crop snaps to 263 × 131.
    expect(result).toMatchObject({
      ok: true,
      data: {
        pixels: { width: 2400, height: 1080 },
        image: { width: 132, height: 66 },
        crop: { x: 0, y: 0, width: 263 / 2.625, height: 131 / 2.625 },
      },
    })
    const file = decodePng(await readFile(out))
    expect(file).toMatchObject({ width: 132, height: 66 })
  })

  it('keeps the pixels of the crop as they are, with no scale', async () => {
    const { context } = emulator36()
    const out = path.join(dir, 'crop.png')

    await runCommand(
      registry,
      'screenshot',
      { out, crop: '10,20,4,2' },
      context,
    )

    // 10,20 dp is 26.25,52.5 px, which snaps to 26,53; 14,22 dp to 37,58.
    const screen = decodePng(Buffer.from(SETTINGS.stdout ?? ''))
    const crop = decodePng(await readFile(out))
    expect(crop).toMatchObject({ width: 11, height: 5 })
    expect(Buffer.from(crop.data)).toEqual(
      Buffer.from(
        cropImage(screen, { x: 26, y: 53, width: 11, height: 5 }).data,
      ),
    )
  })

  it('leaves out the part of the crop that is off the screen', async () => {
    const { context } = emulator36()

    const result = await runCommand(
      registry,
      'screenshot',
      { out: path.join(dir, 'edge.png'), crop: '900,400,100,100' },
      context,
    )

    // 900,400 dp is 2362.5,1050 px; the screen ends at 2400 × 1080.
    expect(result).toMatchObject({
      ok: true,
      data: { image: { width: 37, height: 30 } },
    })
  })

  it('gives invalid_input for a crop with no part on the screen, and writes no file', async () => {
    const { context } = emulator36()
    const out = path.join(dir, 'none.png')

    expect(
      await runCommand(
        registry,
        'screenshot',
        { out, crop: '1000,0,10,10' },
        context,
      ),
    ).toMatchObject({
      ok: false,
      error: {
        code: 'invalid_input',
        message: expect.stringContaining('914.29 × 411.43 dp'),
      },
    })
    expect(existsSync(out)).toBe(false)
  })

  it.each([
    ['a crop with 3 numbers', { crop: '0,0,10' }],
    ['a crop with a negative number', { crop: '-1,0,10,10' }],
    ['a scale of 0', { scale: 0 }],
    ['a scale above 1', { scale: 2 }],
  ])('refuses %s', async (_name, input) => {
    const { context } = emulator36()

    expect(
      await runCommand(
        registry,
        'screenshot',
        { out: path.join(dir, 'bad.png'), ...input },
        context,
      ),
    ).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
  })

  it('gives tool_failed when it must decode a PNG that it cannot read', async () => {
    const { context } = emulator36({ stdout: pngHeader(2400, 1080) })

    expect(
      await runCommand(
        registry,
        'screenshot',
        { out: path.join(dir, 'broken.png'), scale: 0.5 },
        context,
      ),
    ).toMatchObject({
      ok: false,
      error: {
        code: 'tool_failed',
        message: expect.stringContaining("loupe can't read the screenshot."),
      },
    })
  })

  it('prints the crop and the image size', async () => {
    const { context } = emulator36()
    const lines: string[] = []
    const io = {
      out: (text: string) => lines.push(text),
      err: () => {},
      isTTY: true,
    }

    expect(
      await run(
        [
          'screenshot',
          path.join(dir, 'crop.png'),
          '--crop',
          '0,0,100,50',
          '--scale',
          '0.5',
        ],
        io,
        registry,
        context,
      ),
    ).toBe(0)
    expect(lines.join('\n').split('\n').slice(2)).toEqual([
      'Crop: (0, 0) 100.19 × 49.9 dp',
      'Image: 132 × 66 px',
    ])
  })

  it('takes the file by position, and prints a summary', async () => {
    const { context } = emulator36()
    const out = path.join(dir, 'settings.png')
    const lines: string[] = []
    const io = {
      out: (text: string) => lines.push(text),
      err: () => {},
      isTTY: true,
    }

    expect(await run(['screenshot', out], io, registry, context)).toBe(0)
    expect(lines).toEqual([
      `Saved ${out}\nlandscape-left: 914.29 × 411.43 dp (2400 × 1080 px, scale 2.625)`,
    ])
  })

  it('waits for the pixels to turn with the display, then writes the file', async () => {
    const { context } = emulator36([
      { stdout: pngHeader(1080, 2400) },
      SETTINGS,
    ])
    const out = path.join(dir, 'settings.png')

    expect(
      await runCommand(registry, 'screenshot', { out }, context),
    ).toMatchObject({
      ok: true,
      data: { pixels: { width: 2400, height: 1080 } },
    })
    expect(await readFile(out)).toEqual(SETTINGS.stdout)
  })

  it('takes --app, and writes the file while that app is in front', async () => {
    const { context } = emulator36()
    const out = path.join(dir, 'settings.png')
    const io = { out: () => {}, err: () => {}, isTTY: false }

    expect(
      await run(
        ['screenshot', out, '--app', 'com.android.settings'],
        io,
        registry,
        context,
      ),
    ).toBe(0)
    expect(existsSync(out)).toBe(true)
  })

  it('writes no file while another app is in front', async () => {
    const { context } = emulator36()
    const out = path.join(dir, 'settings.png')

    expect(
      await runCommand(
        registry,
        'screenshot',
        { out, app: 'com.example.app' },
        context,
      ),
    ).toMatchObject({ ok: false, error: { code: 'app_not_in_front' } })
    expect(existsSync(out)).toBe(false)
  })

  it('needs a file', async () => {
    const { context, calls } = emulator36()

    expect(await runCommand(registry, 'screenshot', {}, context)).toMatchObject(
      { ok: false, error: { code: 'invalid_input' } },
    )
    expect(calls).toEqual([])
  })
})
