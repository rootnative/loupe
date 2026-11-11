/**
 * The app reports its state in the accessibility label of one hidden view:
 * this prefix, then the report as JSON. loupe finds the label in the UI tree
 * it already reads, so the report needs no network and no port.
 */
export const PROBE_PREFIX = 'loupe:'

/** Goes up when a field changes its meaning, so loupe can refuse an old app. */
export const PROBE_FORMAT = 1

export interface ProbeInsets {
  top: number
  right: number
  bottom: number
  left: number
}

/** Sizes are in pt on iOS and in dp on Android. */
export interface ProbeReport {
  /** The safe-area insets of the current orientation. */
  insets: ProbeInsets
  window: { width: number; height: number }
  /** Pixels per pt or dp. */
  scale: number
  direction: 'ltr' | 'rtl'
  colorScheme: 'light' | 'dark'
  /** The current route, when the app passes it. */
  route?: string
}

export function encodeProbeReport(report: ProbeReport): string {
  const { insets, window, scale, direction, colorScheme, route } = report

  // The fields are named one by one. A caller can pass a larger object, and
  // the label must carry nothing else from the app.
  return (
    PROBE_PREFIX +
    JSON.stringify({
      v: PROBE_FORMAT,
      insets: {
        top: insets.top,
        right: insets.right,
        bottom: insets.bottom,
        left: insets.left,
      },
      window: { width: window.width, height: window.height },
      scale,
      direction,
      colorScheme,
      route,
    })
  )
}
