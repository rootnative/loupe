import { createRegistry } from '../core/command'
import { backgroundCommand } from './background'
import { checkCommand } from './check'
import { devicesCommand } from './devices'
import { dismissCommand } from './dismiss'
import { doubleTapCommand } from './double-tap'
import { dragCommand } from './drag'
import { expoOpenCommand } from './expo-open'
import { expoReloadCommand } from './expo-reload'
import { expoRtlCommand } from './expo-rtl'
import { expoWarmCommand } from './expo-warm'
import { foregroundCommand } from './foreground'
import { holdCommand } from './hold'
import { insetsCommand } from './insets'
import { keyCommand } from './key'
import { measureCommand } from './measure'
import { openUrlCommand } from './open-url'
import { pinchCommand } from './pinch'
import { rotateCommand } from './rotate'
import { screenshotCommand } from './screenshot'
import { scrollToCommand } from './scroll-to'
import { sweepCommand } from './sweep'
import { swipeCommand } from './swipe'
import { tapCommand } from './tap'
import { themeCommand } from './theme'
import { typeCommand } from './type'
import { uiCommand } from './ui'
import { versionCommand } from './version'
import { waitCommand } from './wait'

/** Every loupe command. The CLI is made from this list. */
export const registry = createRegistry([
  backgroundCommand,
  checkCommand,
  devicesCommand,
  dismissCommand,
  doubleTapCommand,
  dragCommand,
  expoOpenCommand,
  expoReloadCommand,
  expoRtlCommand,
  expoWarmCommand,
  foregroundCommand,
  holdCommand,
  insetsCommand,
  keyCommand,
  measureCommand,
  openUrlCommand,
  pinchCommand,
  rotateCommand,
  screenshotCommand,
  scrollToCommand,
  sweepCommand,
  swipeCommand,
  tapCommand,
  themeCommand,
  typeCommand,
  uiCommand,
  versionCommand,
  waitCommand,
])
