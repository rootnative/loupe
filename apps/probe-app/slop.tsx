import { Pressable, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { sideInsets } from './patterns'

// Two buttons that the tree gives as too small. The 40 dp one has a 4 dp
// hitSlop on each side, as an icon button often has, so a finger gets 48 dp;
// the tree doesn't show the hitSlop. The 24 dp one has none.
export function SlopScreen() {
  const insets = useSafeAreaInsets()
  const sides = sideInsets(insets)
  return (
    <View
      style={[
        styles.page,
        {
          paddingTop: insets.top + 16,
          paddingLeft: sides.left + 16,
          paddingRight: sides.right + 16,
        },
      ]}
    >
      <Text testID="slop-caption">Slop</Text>
      <View style={styles.row}>
        <Pressable
          testID="slop-button"
          accessibilityRole="button"
          accessibilityLabel="Slop button"
          hitSlop={4}
          onPress={() => {}}
          style={[styles.button, styles.slop]}
        />
        <Pressable
          testID="small-button"
          accessibilityRole="button"
          accessibilityLabel="Small button"
          onPress={() => {}}
          style={[styles.button, styles.small]}
        />
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  page: { flex: 1, gap: 24, backgroundColor: '#ffffff' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 48 },
  button: { backgroundColor: '#1d1d1f' },
  slop: { width: 40, height: 40 },
  small: { width: 24, height: 24 },
})
