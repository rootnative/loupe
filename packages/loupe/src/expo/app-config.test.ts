import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { RECORD_PATH, setRtl, withKeysOf, withRtl } from './app-config'

const FILE = '/app/app.json'
// The app.json of a new Expo app: two spaces, a line end at the end.
const APP_JSON = `${JSON.stringify(
  { expo: { name: 'Example', slug: 'example', orientation: 'default' } },
  null,
  2,
)}\n`

const roots: string[] = []
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

/** A project folder with this app.json, or with none. */
function project(appJson: string | null = APP_JSON): string {
  const root = mkdtempSync(path.join(tmpdir(), 'loupe-rtl-'))
  roots.push(root)
  if (appJson !== null) writeFileSync(path.join(root, 'app.json'), appJson)
  return root
}

const read = (root: string, file: string) =>
  readFileSync(path.join(root, file), 'utf8')

describe('withRtl', () => {
  it('sets both keys in extra, in the indent and line ends of the file', () => {
    const text = withRtl(APP_JSON, FILE)

    expect(JSON.parse(text).expo.extra).toEqual({
      supportsRTL: true,
      forcesRTL: true,
    })
    expect(text).toMatch(/^\{\n {2}"expo": \{\n/)
    expect(text.endsWith('}\n')).toBe(true)
  })

  it('keeps tabs and CRLF line ends', () => {
    const tabs = `${JSON.stringify({ expo: { name: 'Example' } }, null, '\t')}`
      .replace(/\n/g, '\r\n')
      .concat('\r\n')

    const text = withRtl(tabs, FILE)

    expect(text).toMatch(/^\{\r\n\t"expo": \{\r\n\t\t"name"/)
    expect(text.endsWith('}\r\n')).toBe(true)
    expect(text.replace(/\r\n/g, '')).not.toContain('\n')
  })

  it('keeps the other keys of extra', () => {
    const text = withRtl(
      JSON.stringify({ expo: { extra: { apiUrl: 'x', forcesRTL: false } } }),
      FILE,
    )

    expect(JSON.parse(text).expo.extra).toEqual({
      apiUrl: 'x',
      forcesRTL: true,
      supportsRTL: true,
    })
  })

  it('edits a config with no expo key at its root', () => {
    const text = withRtl(JSON.stringify({ name: 'Example' }), FILE)

    expect(JSON.parse(text)).toEqual({
      name: 'Example',
      extra: { supportsRTL: true, forcesRTL: true },
    })
  })

  it('gives the same text when both keys are already true', () => {
    const on = withRtl(APP_JSON, FILE)

    expect(withRtl(on, FILE)).toBe(on)
  })

  it('gives unsupported for a file that is not a JSON object', () => {
    expect(() => withRtl('[1, 2]', FILE)).toThrow(
      expect.objectContaining({ code: 'unsupported' }),
    )
    expect(() => withRtl('{ expo: ', FILE)).toThrow(
      expect.objectContaining({ code: 'unsupported' }),
    )
  })
})

describe('withKeysOf', () => {
  it('takes away the keys and the extra that RTL on added', () => {
    const changed = withRtl(APP_JSON, FILE).replace('"Example"', '"Renamed"')

    const text = withKeysOf(changed, APP_JSON, FILE)

    expect(JSON.parse(text)).toEqual({
      expo: { name: 'Renamed', slug: 'example', orientation: 'default' },
    })
  })

  it('puts back the values that the original had, and keeps other keys', () => {
    const original = JSON.stringify({ expo: { extra: { supportsRTL: true } } })
    const changed = JSON.stringify({
      expo: { extra: { supportsRTL: true, forcesRTL: true, apiUrl: 'x' } },
    })

    expect(JSON.parse(withKeysOf(changed, original, FILE)).expo.extra).toEqual({
      supportsRTL: true,
      apiUrl: 'x',
    })
  })

  it('gives the same text when nothing changes', () => {
    const text = '{"expo":{"name":"Example"}}'

    expect(withKeysOf(text, text, FILE)).toBe(text)
  })
})

describe('setRtl', () => {
  it('turns RTL on and keeps the record, then puts app.json back byte for byte', async () => {
    const root = project()

    const on = await setRtl(root, 'on')

    expect(on).toMatchObject({
      file: path.join(root, 'app.json'),
      changed: true,
      supports: true,
      forces: true,
    })
    expect(JSON.parse(read(root, 'app.json')).expo.extra.forcesRTL).toBe(true)
    expect(JSON.parse(read(root, RECORD_PATH))).toEqual({
      original: APP_JSON,
      written: read(root, 'app.json'),
    })

    const off = await setRtl(root, 'off')

    expect(off).toMatchObject({ changed: true, supports: false, forces: false })
    expect(read(root, 'app.json')).toBe(APP_JSON)
    expect(existsSync(path.join(root, RECORD_PATH))).toBe(false)
  })

  it('keeps the first original when on runs twice', async () => {
    const root = project()

    await setRtl(root, 'on')
    const again = await setRtl(root, 'on')
    await setRtl(root, 'off')

    expect(again.changed).toBe(false)
    expect(read(root, 'app.json')).toBe(APP_JSON)
  })

  it('puts back only the two keys when app.json changed after on', async () => {
    const root = project()
    await setRtl(root, 'on')
    const file = path.join(root, 'app.json')
    writeFileSync(file, read(root, 'app.json').replace('Example', 'Renamed'))

    await setRtl(root, 'off')

    expect(JSON.parse(read(root, 'app.json'))).toEqual({
      expo: { name: 'Renamed', slug: 'example', orientation: 'default' },
    })
    expect(existsSync(path.join(root, RECORD_PATH))).toBe(false)
  })

  it('changes nothing and keeps no record when the app already forces RTL', async () => {
    const forced = withRtl(APP_JSON, FILE)
    const root = project(forced)

    const on = await setRtl(root, 'on')

    expect(on).toMatchObject({ changed: false, forces: true })
    expect(existsSync(path.join(root, RECORD_PATH))).toBe(false)
    await expect(setRtl(root, 'off')).rejects.toMatchObject({
      code: 'unsupported',
      message: expect.stringContaining("loupe didn't set it"),
    })
    expect(read(root, 'app.json')).toBe(forced)
  })

  it('changes nothing for off with no record', async () => {
    const root = project()

    const off = await setRtl(root, 'off')

    expect(off).toMatchObject({ changed: false, forces: false })
    expect(read(root, 'app.json')).toBe(APP_JSON)
  })

  it('gives unsupported with the lines to add when the app has no app.json', async () => {
    const root = project(null)

    await expect(
      setRtl(root, 'on', path.join(root, 'app.config.ts')),
    ).rejects.toMatchObject({
      code: 'unsupported',
      message: expect.stringMatching(
        /add "supportsRTL: true" and "forcesRTL: true" to the extra of app\.config\.ts/,
      ),
    })
    expect(existsSync(path.join(root, RECORD_PATH))).toBe(false)
  })

  it('gives unsupported for a broken record, and changes nothing', async () => {
    const root = project()
    await mkdir(path.join(root, '.expo'))
    writeFileSync(path.join(root, RECORD_PATH), '{"original": 1}')

    await expect(setRtl(root, 'off')).rejects.toMatchObject({
      code: 'unsupported',
    })
    expect(read(root, 'app.json')).toBe(APP_JSON)
  })

  it('undoes on: app.json as before, and no record', async () => {
    const root = project()

    const on = await setRtl(root, 'on')
    await on.undo()

    expect(read(root, 'app.json')).toBe(APP_JSON)
    expect(existsSync(path.join(root, RECORD_PATH))).toBe(false)
  })
})
