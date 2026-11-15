import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { run } from '../cli/run'
import { byCommand, fakeContext } from '../testing/fake-exec'
import { recorded } from '../testing/fixtures'
import { pngHeader } from '../testing/png'
import { registry } from './index'

const SERIAL = '127.0.0.1:5555'
const ADB = `adb -s ${SERIAL}`
const SHOT = '/data/local/tmp/loupe-drag.png'
const PNG = pngHeader(2400, 1080)

/**
 * An API 36 emulator over TCP, with Settings in front, landscape-left. It has
 * no console, so each gesture is one `input` script, and the script answers
 * with fixed stamps.
 */
function tcpEmulator36() {
  const base = byCommand({
    'adb devices -l': {
      stdout: `List of devices attached\n${SERIAL}         device product:sdk_gphone64_x86_64 model:sdk_gphone64_x86_64 device:emu64xa transport_id:1\n\n`,
    },
    [`${ADB} shell getprop`]: recorded('api-36/device/getprop.txt'),
    [`${ADB} shell dumpsys window displays`]: recorded(
      'api-36/none/rotation-1/settings/dumpsys-window-displays.txt',
    ),
    [`${ADB} exec-out cat ${SHOT}`]: { stdout: PNG },
    [`${ADB} shell rm -f ${SHOT}`]: {},
  })
  const scripts: string[] = []
  const { context } = fakeContext((call) => {
    const script = call.args.at(-1) ?? ''
    if (!script.includes('loupe-stamp')) return base(call)
    scripts.push(script)
    return {
      stdout: [
        'loupe-stamp first 1700000000.000000',
        'loupe-stamp second 1700000000.117000',
        'loupe-stamp move 1700000000.000000',
        'loupe-stamp moved 1700000000.412000',
        ...(script.includes('screencap') ? ['loupe-shot'] : []),
      ].join('\n'),
    }
  })
  return { context, scripts }
}

async function runCli(args: string[]) {
  const { context, scripts } = tcpEmulator36()
  const out: string[] = []
  const io = {
    out: (text: string) => out.push(text),
    err: () => {},
    isTTY: true,
  }
  return { code: await run(args, io, registry, context), out, scripts }
}

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'loupe-gesture-'))
})

afterEach(() => rm(dir, { recursive: true, force: true }))

describe('the gesture commands', () => {
  it('double-tap takes the point by position, and prints the gap', async () => {
    expect(await runCli(['double-tap', '100', '200'])).toMatchObject({
      code: 0,
      out: ['Double-tapped (100, 200) dp, 117 ms between the taps'],
    })
  })

  it('drag takes no screenshot without --shot', async () => {
    const { code, out, scripts } = await runCli([
      'drag',
      '100',
      '100',
      '100',
      '300',
      '--shot-at',
      '0.5',
    ])

    expect(code).toBe(0)
    expect(out).toEqual([
      'Dragged (100, 100) → (100, 300) dp; the move took 412 ms',
    ])
    expect(scripts.join()).not.toContain('screencap')
  })

  it('drag writes the screenshot that it took during the touch', async () => {
    const file = path.join(dir, 'shots', 'drag.png')

    const { code, out } = await runCli([
      'drag',
      '100',
      '100',
      '100',
      '300',
      '--hold-end',
      '500',
      '--shot',
      file,
    ])

    expect(code).toBe(0)
    expect(out).toEqual([
      `Dragged (100, 100) → (100, 300) dp; the move took 412 ms\nSaved ${file}`,
    ])
    expect(await readFile(file)).toEqual(PNG)
  })

  it('refuses an app name that is not a package name, and touches nothing', async () => {
    const { code, scripts } = await runCli([
      'double-tap',
      '100',
      '200',
      '--app',
      "x'; rm -rf /",
    ])

    expect(code).toBe(2)
    expect(scripts).toEqual([])
  })
})
