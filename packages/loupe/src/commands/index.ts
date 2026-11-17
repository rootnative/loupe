import { createRegistry } from '../core/command'
import { checkCommand } from './check'
import { devicesCommand } from './devices'
import { doubleTapCommand } from './double-tap'
import { dragCommand } from './drag'
import { holdCommand } from './hold'
import { insetsCommand } from './insets'
import { keyCommand } from './key'
import { measureCommand } from './measure'
import { openUrlCommand } from './open-url'
import { pinchCommand } from './pinch'
import { rotateCommand } from './rotate'
import { screenshotCommand } from './screenshot'
import { swipeCommand } from './swipe'
import { tapCommand } from './tap'
import { typeCommand } from './type'
import { uiCommand } from './ui'
import { versionCommand } from './version'
import { waitCommand } from './wait'

/** Every loupe command. The CLI is made from this list. */
export const registry = createRegistry([
  checkCommand,
  devicesCommand,
  doubleTapCommand,
  dragCommand,
  holdCommand,
  insetsCommand,
  keyCommand,
  measureCommand,
  openUrlCommand,
  pinchCommand,
  rotateCommand,
  screenshotCommand,
  swipeCommand,
  tapCommand,
  typeCommand,
  uiCommand,
  versionCommand,
  waitCommand,
])
