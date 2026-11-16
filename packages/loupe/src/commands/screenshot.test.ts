import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { run } from '../cli/run'
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
      },
    })
    expect(await readFile(out)).toEqual(SETTINGS.stdout)
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
