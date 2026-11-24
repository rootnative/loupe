import { readFileSync } from 'node:fs'
import { type FakeRoute } from './fake-fetch'

const metro = (file: string): string =>
  readFileSync(
    new URL(`../../fixtures/expo/metro/${file}`, import.meta.url),
    'utf8',
  )

// Round 10, API 36: the manifest is the same on each level but its ids.
export const METRO_STATUS = metro('status.txt')
export const METRO_MANIFEST = metro('manifest.json')
export const BUNDLE_PATH = '/apps/probe-app/index.ts.bundle'
export const BUNDLE = 'var __BUNDLE_START_TIME__=0;'

/** The probe app's Metro: its status, its manifest, and `bundle`. */
export function metroRoutes(
  bundle: FakeRoute = { body: BUNDLE },
): Record<string, FakeRoute> {
  return {
    '/status': { body: METRO_STATUS },
    '/': {
      body: METRO_MANIFEST,
      headers: { 'content-type': 'application/expo+json' },
    },
    [BUNDLE_PATH]: bundle,
  }
}
