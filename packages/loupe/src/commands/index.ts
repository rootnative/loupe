import { createRegistry } from '../core/command'
import { devicesCommand } from './devices'
import { rotateCommand } from './rotate'
import { screenshotCommand } from './screenshot'
import { versionCommand } from './version'

/** Every loupe command. The CLI is made from this list. */
export const registry = createRegistry([
  devicesCommand,
  rotateCommand,
  screenshotCommand,
  versionCommand,
])
