import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

/**
 * Writes a file that the caller asked for. It makes the folder, replaces a
 * file that is there, and gives the absolute path.
 */
export async function writeOutputFile(
  out: string,
  bytes: Buffer,
): Promise<string> {
  const file = path.resolve(out)
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, bytes)
  return file
}
