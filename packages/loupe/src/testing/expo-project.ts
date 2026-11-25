import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { METRO_MANIFEST } from './metro'

/** The app.json of the probe app, as a file of a new Expo app has it. */
export const PROBE_APP_JSON = `${JSON.stringify(
  {
    expo: {
      name: 'Probe app',
      slug: 'probe-app',
      orientation: 'default',
      userInterfaceStyle: 'automatic',
    },
  },
  null,
  2,
)}\n`

const roots: string[] = []

/** A temp project folder with this app.json, or with none (`null`). */
export function tempExpoProject(appJson: string | null = PROBE_APP_JSON) {
  const root = mkdtempSync(path.join(tmpdir(), 'loupe-expo-project-'))
  roots.push(root)
  if (appJson !== null) writeFileSync(path.join(root, 'app.json'), appJson)
  return root
}

/** Removes each temp project folder. Call it in `afterAll`. */
export function removeExpoProjects(): void {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
}

/**
 * The probe app's manifest for the project in `root`, as a `fakeFetch`
 * route. With `live`, it has the extra of app.json now, as Metro reads
 * app.json for each manifest.
 */
export function liveManifest(root: string, live = true) {
  return async () => {
    const manifest = JSON.parse(METRO_MANIFEST)
    manifest.extra.expoGo.developer.projectRoot = root
    const file = path.join(root, 'app.json')
    if (live && existsSync(file)) {
      manifest.extra.expoClient.extra = JSON.parse(
        readFileSync(file, 'utf8'),
      ).expo.extra
    }
    return new Response(JSON.stringify(manifest), {
      headers: { 'content-type': 'application/expo+json' },
    })
  }
}
