import { useEffect, useState } from 'react'
import {
  Alert,
  BackHandler,
  Keyboard,
  Modal,
  PermissionsAndroid,
  Pressable,
  Share,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

// The sheets that `loupe dismiss` must know: the system share sheet, an
// alert, a modal, the permission dialog, and the keyboard. Each one has a
// button (the keyboard has a field) and a status line, so a dump after a
// close shows how the sheet closed. The recorder opens /sheets, opens one
// sheet, and closes it one way.

type Status = Record<
  'share' | 'alert' | 'modal' | 'permission' | 'keyboard',
  string
>

const START: Status = {
  share: 'none',
  alert: 'none',
  modal: 'none',
  permission: 'none',
  keyboard: 'none',
}

export function SheetsScreen() {
  const insets = useSafeAreaInsets()
  const [status, setStatus] = useState(START)
  const [backs, setBacks] = useState(0)
  const [modal, setModal] = useState(false)
  const set = (key: keyof Status, value: string) =>
    setStatus((all) => ({ ...all, [key]: value }))

  // The handler takes each Back that reaches the app, so a Back with no
  // sheet open counts here, and the app stays in front for the next round.
  useEffect(() => {
    const subscription = BackHandler.addEventListener(
      'hardwareBackPress',
      () => {
        setBacks((count) => count + 1)
        return true
      },
    )
    return () => subscription.remove()
  }, [])

  useEffect(() => {
    const shown = Keyboard.addListener('keyboardDidShow', () =>
      set('keyboard', 'shown'),
    )
    const hidden = Keyboard.addListener('keyboardDidHide', () =>
      set('keyboard', 'hidden'),
    )
    return () => {
      shown.remove()
      hidden.remove()
    }
  }, [])

  const share = () => {
    set('share', 'opened')
    Share.share({ message: 'loupe probe' }).then(
      ({ action }) => set('share', action),
      (error: unknown) => set('share', `error ${String(error)}`),
    )
  }

  const alert = () => {
    set('alert', 'open')
    Alert.alert(
      'Probe alert',
      'Close this alert.',
      [
        {
          text: 'Cancel',
          style: 'cancel',
          onPress: () => set('alert', 'cancel'),
        },
        { text: 'OK', onPress: () => set('alert', 'ok') },
      ],
      { cancelable: true, onDismiss: () => set('alert', 'dismissed') },
    )
  }

  const closeModal = (way: string) => {
    setModal(false)
    set('modal', `closed by ${way}`)
  }

  const permission = () => {
    set('permission', 'asked')
    PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.CAMERA).then(
      (result) => set('permission', result),
      (error: unknown) => set('permission', `error ${String(error)}`),
    )
  }

  return (
    <View
      style={[
        styles.page,
        {
          paddingTop: insets.top,
          paddingBottom: insets.bottom + 16,
          paddingLeft: insets.left + 16,
          paddingRight: insets.right + 16,
        },
      ]}
    >
      <View style={styles.lines}>
        {(Object.keys(START) as (keyof Status)[]).map((key) => (
          <Text key={key} testID={key} style={styles.text}>
            {`${key} ${status[key]}`}
          </Text>
        ))}
        <Text testID="backs" style={styles.text}>{`backs ${backs}`}</Text>
      </View>
      <TextInput testID="field" placeholder="Field" style={styles.field} />
      <View style={styles.buttons}>
        <Button id="open-share" title="Share" onPress={share} />
        <Button id="open-alert" title="Alert" onPress={alert} />
        <Button
          id="open-modal"
          title="Modal"
          onPress={() => {
            setModal(true)
            set('modal', 'open')
          }}
        />
        <Button id="open-permission" title="Permission" onPress={permission} />
      </View>
      <Modal
        visible={modal}
        transparent
        animationType="none"
        onRequestClose={() => closeModal('back')}
      >
        <Pressable
          testID="modal-backdrop"
          style={styles.backdrop}
          onPress={() => closeModal('outside')}
        >
          <Pressable
            style={[styles.sheet, { paddingBottom: insets.bottom + 16 }]}
          >
            <Text style={styles.text}>Probe modal</Text>
            <Button
              id="close-modal"
              title="Close"
              onPress={() => closeModal('button')}
            />
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  )
}

function Button({
  id,
  title,
  onPress,
}: {
  id: string
  title: string
  onPress: () => void
}) {
  return (
    <Pressable testID={id} style={styles.button} onPress={onPress}>
      <Text style={styles.buttonText}>{title}</Text>
    </Pressable>
  )
}

// The controls sit in the lower half: the recorder's tap outside a sheet
// lands in the upper part, on nothing of the app.
const styles = StyleSheet.create({
  page: {
    flex: 1,
    justifyContent: 'flex-end',
    gap: 12,
    backgroundColor: '#ffffff',
  },
  lines: { gap: 4 },
  text: { fontSize: 16, color: '#1d1d1f' },
  field: {
    height: 48,
    borderWidth: 1,
    borderColor: '#8e8e93',
    paddingHorizontal: 12,
    fontSize: 16,
    color: '#1d1d1f',
  },
  buttons: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  button: {
    minHeight: 48,
    minWidth: 96,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
    backgroundColor: '#2a9d8f',
  },
  buttonText: { fontSize: 16, color: '#ffffff' },
  backdrop: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0, 0, 0, 0.4)',
  },
  sheet: {
    gap: 12,
    padding: 16,
    alignItems: 'flex-start',
    backgroundColor: '#ffffff',
  },
})
