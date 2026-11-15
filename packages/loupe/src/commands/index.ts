import { createRegistry } from '../core/command'
import { devicesCommand } from './devices'
import { doubleTapCommand } from './double-tap'
import { dragCommand } from './drag'
import { holdCommand } from './hold'
import { insetsCommand } from './insets'
import { keyCommand } from './key'
import { openUrlCommand } from './open-url'
import { pinchCommand } from './pinch'
import { rotateCommand } from './rotate'
import { screenshotCommand } from './screenshot'
import { swipeCommand } from './swipe'
import { tapCommand } from './tap'
import { typeCommand } from './type'
import { uiCommand } from './ui'
import { versionCommand } from './version'

/** Every loupe command. The CLI is made from this list. */
export const registry = createRegistry([
  devicesCommand,
  doubleTapCommand,
  dragCommand,
  holdCommand,
  insetsCommand,
  keyCommand,
  openUrlCommand,
  pinchCommand,
  rotateCommand,
  screenshotCommand,
  swipeCommand,
  tapCommand,
  typeCommand,
  uiCommand,
  versionCommand,
])
