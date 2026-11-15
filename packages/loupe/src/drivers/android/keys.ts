import { LoupeError } from '../../core/errors'
import { type KeyName } from '../../core/keys'
import { shellQuote } from './adb'
import { type AndroidTarget } from './devices'
import { readInFront } from './foreground'

const KEY_CODES: Record<KeyName, string> = {
  back: 'KEYCODE_BACK',
  home: 'KEYCODE_HOME',
  recents: 'KEYCODE_APP_SWITCH',
  enter: 'KEYCODE_ENTER',
  tab: 'KEYCODE_TAB',
  space: 'KEYCODE_SPACE',
  delete: 'KEYCODE_DEL',
  'forward-delete': 'KEYCODE_FORWARD_DEL',
  escape: 'KEYCODE_ESCAPE',
  up: 'KEYCODE_DPAD_UP',
  down: 'KEYCODE_DPAD_DOWN',
  left: 'KEYCODE_DPAD_LEFT',
  right: 'KEYCODE_DPAD_RIGHT',
  'page-up': 'KEYCODE_PAGE_UP',
  'page-down': 'KEYCODE_PAGE_DOWN',
  menu: 'KEYCODE_MENU',
  search: 'KEYCODE_SEARCH',
  'volume-up': 'KEYCODE_VOLUME_UP',
  'volume-down': 'KEYCODE_VOLUME_DOWN',
}

const PRINTABLE_ASCII = /^[\x20-\x7e]+$/

/**
 * Types into the focused field with `input text`. It has keys only for
 * printable ASCII, and it turns "%s" into a space, so loupe refuses those.
 */
export async function typeAndroid(
  target: AndroidTarget,
  text: string,
  app?: string,
): Promise<{ characters: number }> {
  if (!PRINTABLE_ASCII.test(text)) {
    throw new LoupeError(
      'unsupported',
      'On Android, loupe types only printable ASCII characters: input text has no keys for the others. Press Enter with the key command.',
    )
  }
  if (text.includes('%s')) {
    throw new LoupeError(
      'unsupported',
      'On Android, input text turns "%s" into a space, so loupe can\'t type it.',
    )
  }
  await readInFront(target, app)
  await target.adb.run(['shell', 'input', 'text', shellQuote(text)])
  return { characters: text.length }
}

export async function pressAndroid(
  target: AndroidTarget,
  key: KeyName,
  app?: string,
): Promise<{ key: KeyName }> {
  await readInFront(target, app)
  await target.adb.run(['shell', 'input', 'keyevent', KEY_CODES[key]])
  return { key }
}
