import { encodeProbeReport, PROBE_PREFIX } from '@rootnative/loupe-probe'
import {
  I18nManager,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

// The probe's report through two more channels, beside the probe's own
// label, to find the one that an iOS tree shows and VoiceOver doesn't read:
// the identifier alone (`testID`), and an element hidden from VoiceOver.
// The direction is also on the screen as text, so a tree that has no probe
// still gives it.
export function ProbeChannelsScreen() {
  const insets = useSafeAreaInsets()
  const { width, height, scale } = useWindowDimensions()
  const direction = I18nManager.isRTL ? 'rtl' : 'ltr'
  const report = encodeProbeReport({
    insets,
    window: { width, height },
    scale,
    direction,
    route: '/probe-channels',
  }).slice(PROBE_PREFIX.length)

  return (
    <View style={[styles.page, { paddingTop: insets.top + 16 }]}>
      <Text testID="channels-caption">probe channels</Text>
      <Text testID="direction">{`direction ${direction}`}</Text>
      <View
        testID={`loupe-id:${report}`}
        collapsable={false}
        style={[styles.probe, styles.second]}
      />
      <View
        accessible
        accessibilityElementsHidden
        accessibilityLabel={`loupe-hidden:${report}`}
        collapsable={false}
        style={[styles.probe, styles.third]}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  page: { flex: 1, paddingHorizontal: 16 },
  // 1 × 1 and with no background, as the probe: drawn, but not seen.
  probe: {
    position: 'absolute',
    top: 0,
    width: 1,
    height: 1,
    pointerEvents: 'none',
  },
  second: { left: 2 },
  third: { left: 4 },
})
