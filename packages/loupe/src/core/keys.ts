/** The keys that the `key` command presses, by a name for each platform. */
export const KEY_NAMES = [
  'back',
  'home',
  'recents',
  'enter',
  'tab',
  'space',
  'delete',
  'forward-delete',
  'escape',
  'up',
  'down',
  'left',
  'right',
  'page-up',
  'page-down',
  'menu',
  'search',
  'volume-up',
  'volume-down',
] as const

export type KeyName = (typeof KEY_NAMES)[number]
