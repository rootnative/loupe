import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { sideInsets } from './patterns'

const ROW_HEIGHT = 56

export const SCROLL_VARIANTS = ['defect', 'fixed'] as const

export type ScrollVariant = (typeof SCROLL_VARIANTS)[number]

/** The variant of a route such as /scroll/defect. */
export function scrollVariantOf(route: string): ScrollVariant | undefined {
  const [, name, variant] = route.split('/')
  return name === 'scroll' &&
    (SCROLL_VARIANTS as readonly string[]).includes(variant ?? '')
    ? (variant as ScrollVariant)
    : undefined
}

// The rows fill one screen, so the close button after them shows only after
// a scroll down, in each orientation. Defect: the button is 24 × 24 dp. The
// fixed one is 48 × 48 dp with the same 24 dp icon.
export function ScrollScreen({ variant }: { variant: ScrollVariant }) {
  const insets = useSafeAreaInsets()
  const { height } = useWindowDimensions()
  const rows = Math.ceil(height / ROW_HEIGHT)
  const size = variant === 'defect' ? 24 : 48
  return (
    <View style={styles.page}>
      <ScrollView
        testID="list"
        style={{
          marginTop: insets.top,
          marginBottom: insets.bottom,
          ...sideInsets(insets),
        }}
        contentContainerStyle={{ paddingBottom: height / 2 }}
      >
        {Array.from({ length: rows }, (_, index) => (
          <Text key={index} testID={`row-${index + 1}`} style={styles.row}>
            {`Row ${index + 1}`}
          </Text>
        ))}
        <Pressable
          testID="close"
          accessibilityLabel="Close"
          accessibilityRole="button"
          onPress={() => {}}
          style={[styles.close, { width: size, height: size }]}
        >
          <View style={styles.icon} />
        </Pressable>
      </ScrollView>
    </View>
  )
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: '#ffffff' },
  row: {
    height: ROW_HEIGHT,
    paddingHorizontal: 16,
    fontSize: 16,
    textAlignVertical: 'center',
    color: '#1d1d1f',
  },
  close: {
    alignSelf: 'center',
    alignItems: 'center',
    justifyContent: 'center',
  },
  icon: { width: 24, height: 24, backgroundColor: '#1d1d1f' },
})
