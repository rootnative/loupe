import { createRegistry } from '../core/command'
import { devicesCommand } from './devices'
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
  holdCommand,
  rotateCommand,
  screenshotCommand,
  swipeCommand,
  tapCommand,
  uiCommand,
  versionCommand,
])
