import { LoupeProbe } from '@rootnative/loupe-probe'
import { useEffect, useState } from 'react'
import { Linking, StyleSheet, Text, useColorScheme, View } from 'react-native'
import {
  SafeAreaProvider,
  useSafeAreaInsets,
} from 'react-native-safe-area-context'
import { PatternScreen, patternOf } from './patterns'

/**
 * The route of a link: `exp://127.0.0.1:8081/--/inset/defect` gives
 * `/inset/defect`, and a link with no path gives `/`.
 */
function routeOf(url: string | null | undefined): string {
  const path = url?.split('/--/')[1]?.split(/[?#]/)[0] ?? ''
  return `/${path.replace(/^\/+|\/+$/g, '')}`
}

/** The route of the link that opened the app, and of each link after it. */
function useRoute(): string {
  const [route, setRoute] = useState('/')
  useEffect(() => {
    void Linking.getInitialURL().then((url) => setRoute(routeOf(url)))
    const subscription = Linking.addEventListener('url', ({ url }) =>
      setRoute(routeOf(url)),
    )
    return () => subscription.remove()
  }, [])
  return route
}

export default function App() {
  const route = useRoute()
  const pattern = patternOf(route)
  return (
    <SafeAreaProvider>
      {pattern ? <PatternScreen {...pattern} /> : <Screen />}
      <LoupeProbe route={route} />
    </SafeAreaProvider>
  )
}

// The panel fills the safe area that the app gets. So a screenshot shows the
// insets in the outer colour, and the dump gives the panel's bounds under its
// label.
function Screen() {
  const { top, right, bottom, left } = useSafeAreaInsets()
  const dark = useColorScheme() === 'dark'
  const textStyle = [styles.text, dark && styles.textDark]

  return (
    <View style={[styles.screen, dark && styles.screenDark]}>
      <View
        accessibilityLabel="safe area"
        style={[
          styles.panel,
          dark && styles.panelDark,
          { top, right, bottom, left },
        ]}
      >
        <Text style={textStyle}>Probe app</Text>
        <Text style={textStyle}>
          {`Insets: top ${top}, right ${right}, bottom ${bottom}, left ${left}`}
        </Text>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#e76f51' },
  screenDark: { backgroundColor: '#7a3b2e' },
  panel: {
    position: 'absolute',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: '#ffffff',
  },
  panelDark: { backgroundColor: '#1d1d1f' },
  text: { fontSize: 16, color: '#1d1d1f' },
  textDark: { color: '#ffffff' },
})
