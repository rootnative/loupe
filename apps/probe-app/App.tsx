import { LoupeProbe } from '@rootnative/loupe-probe'
import { useEffect, useState } from 'react'
import {
  AppState,
  Linking,
  StyleSheet,
  Text,
  useColorScheme,
  View,
} from 'react-native'
import {
  SafeAreaProvider,
  useSafeAreaInsets,
} from 'react-native-safe-area-context'
import { PatternScreen, patternOf } from './patterns'
import { SheetsScreen } from './sheets'

/**
 * The route of a link: `exp://127.0.0.1:8081/--/inset/defect` gives
 * `/inset/defect`, and a link with no path gives `/`.
 */
function routeOf(url: string | null | undefined): string {
  const path = url?.split('/--/')[1]?.split(/[?#]/)[0] ?? ''
  return `/${path.replace(/^\/+|\/+$/g, '')}`
}

/**
 * The route of the link that opened the app, and of each link after it, and
 * the count of those later links.
 */
function useRoute(): { route: string; links: number } {
  const [route, setRoute] = useState('/')
  const [links, setLinks] = useState(0)
  useEffect(() => {
    void Linking.getInitialURL().then((url) => setRoute(routeOf(url)))
    const subscription = Linking.addEventListener('url', ({ url }) => {
      setRoute(routeOf(url))
      setLinks((count) => count + 1)
    })
    return () => subscription.remove()
  }, [])
  return { route, links }
}

/** Each AppState of this run of the bundle, from the first one. */
function useAppStates(): string[] {
  const [states, setStates] = useState<string[]>([
    AppState.currentState ?? 'unknown',
  ])
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) =>
      setStates((all) => [...all, state]),
    )
    return () => subscription.remove()
  }, [])
  return states
}

// A new id for each run of the bundle: a reload gives another one.
const RUN = Math.random().toString(36).slice(2, 8)

export default function App() {
  const { route, links } = useRoute()
  const states = useAppStates()
  const pattern = patternOf(route)
  let screen = <Screen />
  if (pattern) screen = <PatternScreen {...pattern} />
  if (route === '/appstate') {
    screen = <AppStateScreen states={states} links={links} />
  }
  if (route === '/sheets') screen = <SheetsScreen />
  return (
    <SafeAreaProvider>
      {screen}
      <LoupeProbe route={route} />
    </SafeAreaProvider>
  )
}

// What the app saw while it went to the background and came back: the run
// (the same one, or a reload), each AppState, and the links after the first.
function AppStateScreen({
  states,
  links,
}: {
  states: readonly string[]
  links: number
}) {
  return (
    <View style={styles.appState}>
      <Text testID="run" style={styles.text}>{`run ${RUN}`}</Text>
      <Text testID="app-states" style={styles.text}>
        {states.join(' ')}
      </Text>
      <Text testID="links" style={styles.text}>{`links ${links}`}</Text>
    </View>
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
  appState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: '#ffffff',
  },
  text: { fontSize: 16, color: '#1d1d1f' },
  textDark: { color: '#ffffff' },
})
