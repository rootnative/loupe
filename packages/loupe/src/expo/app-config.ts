import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { LoupeError } from '../core/errors'

export type RtlMode = 'on' | 'off'

/** The keys of `extra` that Expo Go reads each time it loads the app. */
const KEYS = ['supportsRTL', 'forcesRTL'] as const

/** Where `on` keeps app.json as it was, in the git-ignored folder of Expo. */
export const RECORD_PATH = path.join('.expo', 'loupe-rtl.json')

const recordSchema = z.object({ original: z.string(), written: z.string() })
type RtlRecord = z.infer<typeof recordSchema>

type Json = Record<string, unknown>

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function parseAppJson(text: string, file: string): Json {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    json = undefined
  }
  if (!isObject(json)) {
    throw new LoupeError(
      'unsupported',
      `${file} isn't a JSON object, so loupe can't edit it.`,
    )
  }
  return json
}

/** The Expo config of app.json: under `expo`, or the whole file. */
const expoConfigOf = (json: Json): Json =>
  isObject(json.expo) ? json.expo : json

/** `json` as text with the indent, line ends and last line end of `like`. */
function formatLike(json: Json, like: string): string {
  const indent = /^[^\n]*\n([ \t]+)\S/.exec(like)?.[1] ?? '  '
  const text = `${JSON.stringify(json, null, indent)}${like.endsWith('\n') ? '\n' : ''}`
  return like.includes('\r\n') ? text.replace(/\n/g, '\r\n') : text
}

/** `text` with `extra.supportsRTL` and `extra.forcesRTL` true. */
export function withRtl(text: string, file: string): string {
  const json = parseAppJson(text, file)
  const config = expoConfigOf(json)
  const extra = isObject(config.extra) ? config.extra : {}
  if (extra.supportsRTL === true && extra.forcesRTL === true) return text
  config.extra = { ...extra, supportsRTL: true, forcesRTL: true }
  return formatLike(json, text)
}

/**
 * `text` with the two keys as `original` has them: a key that `original`
 * doesn't have goes. An `extra` that only the two keys made goes too.
 */
export function withKeysOf(
  text: string,
  original: string,
  file: string,
): string {
  const json = parseAppJson(text, file)
  const config = expoConfigOf(json)
  const before = expoConfigOf(parseAppJson(original, file)).extra
  const extra: Json = isObject(config.extra) ? { ...config.extra } : {}
  for (const key of KEYS) {
    if (isObject(before) && key in before) extra[key] = before[key]
    else delete extra[key]
  }
  if (Object.keys(extra).length === 0 && !isObject(before)) delete config.extra
  else config.extra = extra
  const unchanged =
    JSON.stringify(json) === JSON.stringify(parseAppJson(text, file))
  return unchanged ? text : formatLike(json, text)
}

/** `extra.supportsRTL` and `extra.forcesRTL` of app.json, as true or not. */
function rtlOf(
  text: string,
  file: string,
): { supports: boolean; forces: boolean } {
  const extra = expoConfigOf(parseAppJson(text, file)).extra
  return {
    supports: isObject(extra) && extra.supportsRTL === true,
    forces: isObject(extra) && extra.forcesRTL === true,
  }
}

/** The text of a file, or undefined when it isn't there. */
async function readText(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

async function readRecord(file: string): Promise<RtlRecord | undefined> {
  const text = await readText(file)
  if (text === undefined) return undefined
  let record: RtlRecord | undefined
  try {
    record = recordSchema.safeParse(JSON.parse(text)).data
  } catch {
    record = undefined
  }
  if (!record) {
    throw new LoupeError(
      'unsupported',
      `${file} isn't a record of loupe, so loupe can't put app.json back. Compare app.json with the version in git, then delete the record.`,
    )
  }
  return record
}

async function writeRecord(file: string, record: RtlRecord): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify(record, null, 2)}\n`)
}

/**
 * The app.json of the app in `projectRoot`, and its text. With none:
 * `unsupported`, with the two lines to add (`on`) or to remove (`off`).
 */
export async function requireAppJson(
  projectRoot: string,
  mode: RtlMode,
  dynamicConfigPath?: string,
): Promise<{ file: string; text: string }> {
  const file = path.resolve(projectRoot, 'app.json')
  const text = await readText(file)
  if (text === undefined) {
    const config = dynamicConfigPath?.split(/[\\/]/).pop() ?? 'app.config.js'
    throw new LoupeError(
      'unsupported',
      `loupe edits only app.json, and ${projectRoot} has none. Ask the user to ${mode === 'on' ? 'add "supportsRTL: true" and "forcesRTL: true" to' : 'remove "supportsRTL" and "forcesRTL" from'} the extra of ${config}, then run expo-reload.`,
    )
  }
  return { file, text }
}

export interface RtlChange {
  /** app.json, as an absolute path. */
  file: string
  /** True when loupe wrote app.json. */
  changed: boolean
  /** `extra.supportsRTL` and `extra.forcesRTL` of app.json after the change. */
  supports: boolean
  forces: boolean
  /** Puts app.json and the record back as they were before the change. */
  undo: () => Promise<void>
}

/**
 * Turns RTL on or off in the app.json of the app in `projectRoot`. `on`
 * sets `extra.supportsRTL` and `extra.forcesRTL`, and keeps app.json as it
 * was in the record. `off` writes that text back, or only the two keys when
 * app.json changed after `on`, and deletes the record.
 */
export async function setRtl(
  projectRoot: string,
  mode: RtlMode,
  dynamicConfigPath?: string,
): Promise<RtlChange> {
  const { file, text } = await requireAppJson(
    projectRoot,
    mode,
    dynamicConfigPath,
  )
  const recordFile = path.resolve(projectRoot, RECORD_PATH)
  const record = await readRecord(recordFile)

  let next = text
  let nextRecord: RtlRecord | undefined = record
  if (mode === 'on') {
    next = withRtl(text, file)
    if (record) nextRecord = { ...record, written: next }
    else if (next !== text) nextRecord = { original: text, written: next }
  } else if (record) {
    next =
      text === record.written
        ? record.original
        : withKeysOf(text, record.original, file)
    nextRecord = undefined
  } else if (rtlOf(text, file).forces) {
    throw new LoupeError(
      'unsupported',
      `${file} sets forcesRTL, and loupe didn't set it, so loupe doesn't change it. Ask the user.`,
    )
  }

  // The record goes first: app.json changes only when its way back is kept.
  if (nextRecord) await writeRecord(recordFile, nextRecord)
  if (next !== text) await writeFile(file, next)
  if (!nextRecord && record) await rm(recordFile, { force: true })

  return {
    file,
    changed: next !== text,
    ...rtlOf(next, file),
    undo: async () => {
      if (next !== text) await writeFile(file, text)
      if (record) await writeRecord(recordFile, record)
      else await rm(recordFile, { force: true })
    },
  }
}
