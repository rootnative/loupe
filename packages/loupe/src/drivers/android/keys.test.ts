import { describe, expect, it } from 'vitest'
import {
  byCommand,
  type FakeCall,
  type FakeRun,
  fakeContext,
} from '../../testing/fake-exec'
import { recorded } from '../../testing/fixtures'
import { shellQuote } from './adb'
import { selectAndroidDevice } from './devices'
import { pressAndroid, typeAndroid } from './keys'

const ADB = 'adb -s emulator-5554'

/** Settings in front. */
function emulator(runs: Readonly<Record<string, FakeRun>> = {}) {
  const { context, calls } = fakeContext(
    byCommand({
      'adb devices -l': recorded('api-36/host/adb-devices-l.txt'),
      [`${ADB} shell getprop`]: recorded('api-36/device/getprop.txt'),
      [`${ADB} shell dumpsys window displays`]: recorded(
        'api-36/none/rotation-1/settings/dumpsys-window-displays.txt',
      ),
      ...runs,
    }),
  )
  return { calls, target: () => selectAndroidDevice(context) }
}

function inputs(calls: readonly FakeCall[]): string[] {
  return calls
    .filter((call) => call.args.includes('input'))
    .map((call) => call.args.slice(call.args.indexOf('input')).join(' '))
}

describe('shellQuote', () => {
  it.each([
    ['hello world', `'hello world'`],
    [`it's`, `'it'\\''s'`],
    ['a&b;$(c)`d`', `'a&b;$(c)\`d\`'`],
  ])('quotes %s', (value, quoted) => {
    expect(shellQuote(value)).toBe(quoted)
  })
})

describe('typeAndroid', () => {
  it('types the text as one quoted argument, and gives only its length', async () => {
    const { calls, target } = emulator({
      [`${ADB} shell input text 'it'\\''s 5 o'\\''clock'`]: {},
    })

    expect(await typeAndroid(await target(), "it's 5 o'clock")).toEqual({
      characters: 14,
    })
    expect(inputs(calls)).toEqual([`input text 'it'\\''s 5 o'\\''clock'`])
  })

  it.each([
    ['héllo', 'printable ASCII'],
    ['line\nline', 'printable ASCII'],
    ['😀', 'printable ASCII'],
    ['100%s', '"%s"'],
  ])('refuses %j, and types nothing', async (text, reason) => {
    const { calls, target } = emulator()

    await expect(typeAndroid(await target(), text)).rejects.toMatchObject({
      code: 'unsupported',
      message: expect.stringContaining(reason),
    })
    expect(inputs(calls)).toEqual([])
  })

  it('types nothing while another app is in front', async () => {
    const { calls, target } = emulator()

    await expect(
      typeAndroid(await target(), 'secret', 'com.example.app'),
    ).rejects.toMatchObject({ code: 'app_not_in_front' })
    expect(inputs(calls)).toEqual([])
  })
})

describe('pressAndroid', () => {
  it.each([
    ['back', 'KEYCODE_BACK'],
    ['recents', 'KEYCODE_APP_SWITCH'],
    ['delete', 'KEYCODE_DEL'],
    ['up', 'KEYCODE_DPAD_UP'],
  ] as const)('presses %s as %s', async (key, code) => {
    const { calls, target } = emulator({
      [`${ADB} shell input keyevent ${code}`]: {},
    })

    expect(await pressAndroid(await target(), key)).toEqual({ key })
    expect(inputs(calls)).toEqual([`input keyevent ${code}`])
  })
})
