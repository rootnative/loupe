import { createRegistry } from '../core/command'
import { devicesCommand } from './devices'
import { doubleTapCommand } from './double-tap'
import { dragCommand } from './drag'
import { holdCommand } from './hold'
import { rotateCommand } from './rotate'
import { screenshotCommand } from './screenshot'
import { swipeCommand } from './swipe'
import { tapCommand } from './tap'
import { uiCommand } from './ui'
import { versionCommand } from './version'

/** Every loupe command. The CLI is made from this list. */
export const registry = createRegistry([
  devicesCommand,
  doubleTapCommand,
  dragCommand,
  holdCommand,
  rotateCommand,
  screenshotCommand,
  swipeCommand,
  tapCommand,
  uiCommand,
  versionCommand,
])
