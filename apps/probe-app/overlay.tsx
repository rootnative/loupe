import { useEffect, useState } from 'react'
import { BackHandler, Pressable, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { sideInsets } from './patterns'

// An overlay in the app's own window, as a component library draws a menu
// or a bottom sheet: a scrim over the whole screen that closes it on a
// press, and a panel in the safe area. Back closes it too.
export function OverlayScreen() {
  const insets = useSafeAreaInsets()
  const [open, setOpen] = useState(true)
  useEffect(() => {
    if (!open) return
    const subscription = BackHandler.addEventListener(
      'hardwareBackPress',
      () => {
        setOpen(false)
        return true
      },
    )
    return () => subscription.remove()
  }, [open])
  const sides = sideInsets(insets)

  return (
    <View style={styles.page}>
      <View
        style={[
          styles.content,
          {
            paddingTop: insets.top + 16,
            paddingBottom: insets.bottom + 16,
            paddingLeft: sides.left + 16,
            paddingRight: sides.right + 16,
          },
        ]}
      >
        <Text testID="overlay-status">
          {open ? 'overlay open' : 'overlay closed'}
        </Text>
        <Pressable
          testID="open-overlay"
          accessibilityRole="button"
          onPress={() => setOpen(true)}
          style={styles.button}
        >
          <Text>Open overlay</Text>
        </Pressable>
      </View>
      {open ? (
        <>
          <Pressable
            testID="scrim"
            accessibilityRole="button"
            accessibilityLabel="Close overlay"
            onPress={() => setOpen(false)}
            style={styles.scrim}
          />
          <View
            style={[
              styles.panel,
              { top: insets.top + 16, left: sides.left + 16 },
            ]}
          >
            <Text testID="overlay-panel">Overlay panel</Text>
          </View>
        </>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: '#ffffff' },
  content: { flex: 1, gap: 16, alignItems: 'flex-start' },
  button: {
    minWidth: 48,
    minHeight: 48,
    paddingHorizontal: 16,
    justifyContent: 'center',
    backgroundColor: '#d9e2ec',
  },
  scrim: {
    ...StyleSheet.absoluteFill,
    backgroundColor: 'rgba(0, 0, 0, 0.32)',
  },
  panel: {
    position: 'absolute',
    width: 200,
    padding: 16,
    backgroundColor: '#ffffff',
  },
})
