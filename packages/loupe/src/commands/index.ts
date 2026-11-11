import { createRegistry } from '../core/command'
import { versionCommand } from './version'

/** Every loupe command. The CLI is made from this list. */
export const registry = createRegistry([versionCommand])
