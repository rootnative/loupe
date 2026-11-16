import { useContext } from 'react'
import {
  I18nManager,
  StyleSheet,
  useColorScheme,
  useWindowDimensions,
  View,
} from 'react-native'
import { SafeAreaInsetsContext } from 'react-native-safe-area-context'
import { encodeProbeReport } from './report'

export interface LoupeProbeProps {
  /** The current route, for example the path that your router gives. */
  route?: string
}

/**
 * Reports the safe-area insets, the window, the layout direction and the
 * colour scheme of the app to loupe. Render it once, near the root, inside
 * your `SafeAreaProvider`. It renders nothing unless `__DEV__` is true.
 */
export function LoupeProbe(props: LoupeProbeProps) {
  return __DEV__ ? <Probe {...props} /> : null
}

function Probe({ route }: LoupeProbeProps) {
  // Not `useSafeAreaInsets`: it throws with no provider, and a development
  // helper must never crash the app.
  const insets = useContext(SafeAreaInsetsContext)
  const { width, height, scale } = useWindowDimensions()
  const colorScheme = useColorScheme()

  const label = encodeProbeReport({
    insets: insets ?? undefined,
    window: { width, height },
    scale,
    direction: I18nManager.isRTL ? 'rtl' : 'ltr',
    colorScheme:
      colorScheme === 'light' || colorScheme === 'dark'
        ? colorScheme
        : undefined,
    route,
  })

  return (
    <View
      accessibilityLabel={label}
      importantForAccessibility="no"
      collapsable={false}
      style={styles.probe}
    />
  )
}

const styles = StyleSheet.create({
  // uiautomator leaves a node out of its dump when the user can't see it: an
  // empty frame, alpha 0, or a hidden parent. So the view is 1 × 1, and it
  // draws nothing because it has no background.
  probe: {
    position: 'absolute',
    top: 0,
    left: 0,
    width: 1,
    height: 1,
    pointerEvents: 'none',
  },
})
