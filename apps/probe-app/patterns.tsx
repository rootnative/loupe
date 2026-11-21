import { type ReactNode, useState } from 'react'
import {
  I18nManager,
  type LayoutRectangle,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import {
  type EdgeInsets,
  useSafeAreaInsets,
} from 'react-native-safe-area-context'

// Each pattern is a layout defect that a check must find, with a fixed twin
// that the same check must pass. The recorder opens each one at
// /<pattern>/<variant>, in each rotation, in LTR and in RTL.

export const PATTERNS = [
  'inset',
  'sheet',
  'sides',
  'overflow',
  'target',
  'centred',
  'mirrored',
] as const

export const VARIANTS = ['defect', 'fixed'] as const

export type Pattern = (typeof PATTERNS)[number]
export type Variant = (typeof VARIANTS)[number]

interface PatternProps {
  pattern: Pattern
  variant: Variant
}

/** The pattern of a route such as /inset/defect. */
export function patternOf(route: string): PatternProps | undefined {
  const [, pattern, variant] = route.split('/')
  const isPattern = (PATTERNS as readonly string[]).includes(pattern ?? '')
  const isVariant = (VARIANTS as readonly string[]).includes(variant ?? '')
  return isPattern && isVariant
    ? { pattern: pattern as Pattern, variant: variant as Variant }
    : undefined
}

/**
 * Fabric swaps the left and the right styles in RTL while
 * doLeftAndRightSwapInRTL is on, and insets are physical. So a fixed layout
 * writes each side inset under the key that lands on that side.
 */
export function sideInsets(insets: EdgeInsets): {
  left: number
  right: number
} {
  const swap = I18nManager.isRTL && I18nManager.doLeftAndRightSwapInRTL
  return swap
    ? { left: insets.right, right: insets.left }
    : { left: insets.left, right: insets.right }
}

const SCREENS: Record<Pattern, (props: { variant: Variant }) => ReactNode> = {
  inset: Inset,
  sheet: Sheet,
  sides: Sides,
  overflow: Overflow,
  target: Target,
  centred: Centred,
  mirrored: Mirrored,
}

export function PatternScreen({ pattern, variant }: PatternProps) {
  const Screen = SCREENS[pattern]
  return (
    <View style={styles.page}>
      <View style={styles.caption}>
        <Text testID="caption">{`${pattern} · ${variant}`}</Text>
      </View>
      <Screen variant={variant} />
    </View>
  )
}

// Defect: a label in each corner of the screen, with no safe-area padding,
// so the bars and the cutout cover them.
function Inset({ variant }: { variant: Variant }) {
  const insets = useSafeAreaInsets()
  const fixed = variant === 'fixed'
  const sides = fixed ? sideInsets(insets) : { left: 0, right: 0 }
  return (
    <>
      <View style={[styles.cornerRow, { top: fixed ? insets.top : 0 }, sides]}>
        <Text testID="top-start">Top start</Text>
        <Text testID="top-end">Top end</Text>
      </View>
      <View
        style={[styles.cornerRow, { bottom: fixed ? insets.bottom : 0 }, sides]}
      >
        <Text testID="bottom-start">Bottom start</Text>
        <Text testID="bottom-end">Bottom end</Text>
      </View>
    </>
  )
}

// Defect: a sheet as tall as the screen, so its title sits under the status
// bar. The fixed sheet stops at the top inset.
function Sheet({ variant }: { variant: Variant }) {
  const insets = useSafeAreaInsets()
  const { left, right } = sideInsets(insets)
  return (
    <View
      testID="sheet"
      style={[styles.sheet, { top: variant === 'fixed' ? insets.top : 0 }]}
    >
      <Text
        testID="sheet-title"
        style={[
          styles.title,
          { marginLeft: left + 16, marginRight: right + 16 },
        ]}
      >
        Sheet title
      </Text>
      <View style={styles.fill} />
      <Pressable
        testID="sheet-done"
        accessibilityRole="button"
        onPress={() => {}}
        style={[
          styles.button,
          { marginBottom: insets.bottom + 16, marginRight: right + 16 },
        ]}
      >
        <Text>Done</Text>
      </Pressable>
    </View>
  )
}

// Defect: the side padding takes the physical insets as they are. In RTL,
// Fabric swaps them, so with a one-sided cutout the content moves under it.
function Sides({ variant }: { variant: Variant }) {
  const insets = useSafeAreaInsets()
  const { left, right } =
    variant === 'fixed'
      ? sideInsets(insets)
      : { left: insets.left, right: insets.right }
  return (
    <View
      style={[
        StyleSheet.absoluteFill,
        {
          paddingTop: insets.top,
          paddingBottom: insets.bottom,
          paddingLeft: left,
          paddingRight: right,
        },
      ]}
    >
      <View style={styles.row}>
        <Text testID="lead">Lead</Text>
        <Text testID="tail">Tail</Text>
      </View>
    </View>
  )
}

const WORDS = ['First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth']

// Defect: a row 1200 dp wide, so its last items run past the screen edge.
// The fixed row wraps. The carousel in both runs past the edge on purpose:
// it scrolls, so it isn't a defect.
function Overflow({ variant }: { variant: Variant }) {
  const insets = useSafeAreaInsets()
  return (
    <View
      style={[styles.content, { top: insets.top + 16 }, sideInsets(insets)]}
    >
      <View
        testID="row"
        style={variant === 'defect' ? styles.wideRow : styles.wrapRow}
      >
        {WORDS.map((word) => (
          <Text key={word} testID={`item-${word}`} style={styles.item}>
            {word}
          </Text>
        ))}
      </View>
      <ScrollView testID="carousel" horizontal style={styles.carousel}>
        {Array.from({ length: 8 }, (_, index) => (
          <View key={index} testID={`card-${index + 1}`} style={styles.card}>
            <Text>{`Card ${index + 1}`}</Text>
          </View>
        ))}
      </ScrollView>
    </View>
  )
}

// Defect: a close button of 24 × 24 dp. The fixed one is 48 × 48 dp with
// the same 24 dp icon. The 16 dp decoration takes no touch in both.
function Target({ variant }: { variant: Variant }) {
  const insets = useSafeAreaInsets()
  const size = variant === 'defect' ? 24 : 48
  return (
    <View
      style={[
        styles.content,
        styles.targets,
        { top: insets.top + 16 },
        sideInsets(insets),
      ]}
    >
      <Pressable
        testID="close"
        accessibilityLabel="Close"
        accessibilityRole="button"
        onPress={() => {}}
        style={[styles.centre, { width: size, height: size }]}
      >
        <View style={styles.icon} />
      </Pressable>
      <View testID="decoration" style={styles.decoration} />
    </View>
  )
}

const ACTIONS = ['Search', 'Share', 'More']

// Defect: the title takes the space between the back button (48 dp) and
// the three actions (144 dp), so its centre is 48 dp off the bar's centre.
// The fixed title spans the whole bar.
function Centred({ variant }: { variant: Variant }) {
  const insets = useSafeAreaInsets()
  const title = (
    <Text
      testID="bar-title"
      numberOfLines={1}
      style={variant === 'defect' ? styles.flexTitle : styles.overTitle}
    >
      Centred title
    </Text>
  )
  return (
    <View
      testID="bar"
      style={[styles.bar, { top: insets.top }, sideInsets(insets)]}
    >
      <Pressable
        testID="back"
        accessibilityLabel="Back"
        onPress={() => {}}
        style={styles.barButton}
      />
      {variant === 'defect' ? title : <View style={styles.fill} />}
      {ACTIONS.map((action) => (
        <Pressable
          key={action}
          testID={`action-${action.toLowerCase()}`}
          accessibilityLabel={action}
          onPress={() => {}}
          style={styles.barButton}
        />
      ))}
      {variant === 'fixed' && title}
    </View>
  )
}

const MENU_WIDTH = 160

// The menu opens under its button, start edge to start edge. Its place on
// the screen is physical: the bar starts at the left inset, and the button's
// layout x is physical too. (Not measureInWindow: on Android it leaves out
// the status bar and a side cutout.) Defect: it writes that place as
// `left`, which Fabric swaps in RTL, so the menu opens on the far side. The
// fixed menu writes it under the key that lands on the left.
function Mirrored({ variant }: { variant: Variant }) {
  const insets = useSafeAreaInsets()
  const [button, setButton] = useState<LayoutRectangle>()

  const swap = I18nManager.isRTL && I18nManager.doLeftAndRightSwapInRTL
  let place: { left: number } | { right: number } | undefined
  if (button) {
    const x = insets.left + button.x
    const left = I18nManager.isRTL ? x + button.width - MENU_WIDTH : x
    place = variant === 'fixed' && swap ? { right: left } : { left }
  }

  return (
    <>
      <View style={[styles.bar, { top: insets.top }, sideInsets(insets)]}>
        <Pressable
          testID="menu-button"
          accessibilityRole="button"
          onPress={() => {}}
          onLayout={(event) => setButton(event.nativeEvent.layout)}
          style={styles.button}
        >
          <Text>Menu</Text>
        </Pressable>
      </View>
      {button && place && (
        <View
          testID="menu"
          style={[
            styles.menu,
            { top: insets.top + button.y + button.height },
            place,
          ]}
        >
          <Text testID="menu-edit">Edit</Text>
          <Text testID="menu-delete">Delete</Text>
        </View>
      )}
    </>
  )
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: '#f4f1ea' },
  caption: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: 'center',
    justifyContent: 'center',
    pointerEvents: 'none',
  },
  fill: { flex: 1 },
  centre: { alignItems: 'center', justifyContent: 'center' },
  cornerRow: {
    position: 'absolute',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  row: { flexDirection: 'row', justifyContent: 'space-between' },
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingTop: 12,
    backgroundColor: '#ffffff',
  },
  title: { fontSize: 20 },
  button: {
    alignSelf: 'flex-end',
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 72,
    height: 48,
    backgroundColor: '#d9e2ec',
  },
  content: { position: 'absolute' },
  wideRow: { flexDirection: 'row', width: 1200 },
  wrapRow: { flexDirection: 'row', flexWrap: 'wrap' },
  item: { width: 200, height: 32 },
  carousel: { marginTop: 16 },
  card: {
    width: 140,
    height: 80,
    marginRight: 12,
    backgroundColor: '#d9e2ec',
  },
  targets: { flexDirection: 'row', alignItems: 'center', gap: 16 },
  icon: { width: 24, height: 24, backgroundColor: '#1d1d1f' },
  decoration: { width: 16, height: 16, backgroundColor: '#e76f51' },
  bar: {
    position: 'absolute',
    height: 64,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#d9e2ec',
  },
  barButton: { width: 48, height: 48, backgroundColor: '#bcccdc' },
  flexTitle: { flex: 1, fontSize: 20, textAlign: 'center' },
  overTitle: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    fontSize: 20,
    textAlign: 'center',
    textAlignVertical: 'center',
  },
  menu: {
    position: 'absolute',
    width: MENU_WIDTH,
    padding: 12,
    gap: 12,
    backgroundColor: '#ffffff',
  },
})
