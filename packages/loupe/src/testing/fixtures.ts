import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { type FakeRun } from './fake-exec'

/** The API levels in `fixtures/android`, from the Android fixtures workflow. */
export const API_LEVELS = [30, 33, 34, 35, 36] as const

const ANDROID = fileURLToPath(
  new URL('../../fixtures/android/', import.meta.url),
)

/**
 * One recorded run, for example `api-34/host/adb-devices-l.txt`: stdout, and
 * the `.stderr` and `.exit` files next to it when the recorder wrote them.
 */
export function recorded(file: string): FakeRun {
  const stdout = path.join(ANDROID, file)
  const stderr = `${stdout}.stderr`
  const exit = `${stdout}.exit`
  return {
    stdout: readFileSync(stdout),
    stderr: existsSync(stderr) ? readFileSync(stderr, 'utf8') : undefined,
    code: existsSync(exit) ? Number(readFileSync(exit, 'utf8').trim()) : 0,
  }
}

export function recordedText(file: string): string {
  return readFileSync(path.join(ANDROID, file), 'utf8')
}

const IOS = fileURLToPath(new URL('../../fixtures/ios/', import.meta.url))

/**
 * One recorded file of `fixtures/ios`, from the iOS fixtures workflow, for
 * example `intel/host/simctl-list.json`.
 */
export function recordedIosText(file: string): string {
  return readFileSync(path.join(IOS, file), 'utf8')
}

/** One recorded file of `fixtures/ios` as bytes, for example a screenshot. */
export function recordedIos(file: string): Buffer {
  return readFileSync(path.join(IOS, file))
}
