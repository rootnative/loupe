import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The folder of the loupe package: the nearest one above `from` with a
 * `package.json`. The code runs from `src` in tests and from `dist` in the
 * package, so a file of the package is found from here, not by a fixed
 * number of steps up.
 */
export function packageFolder(
  from = path.dirname(fileURLToPath(import.meta.url)),
): string {
  let dir = from
  for (;;) {
    if (existsSync(path.join(dir, 'package.json'))) return dir
    const up = path.dirname(dir)
    if (up === dir) throw new Error("loupe can't find its package folder.")
    dir = up
  }
}
