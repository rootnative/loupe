import { z } from 'zod'
import { defineCommand } from '../core/command'
import { version } from '../version'

export const versionCommand = defineCommand({
  name: 'version',
  summary: 'Print the loupe version and the host it runs on',
  input: z.object({}),
  output: z.object({
    loupe: z.string(),
    node: z.string(),
    platform: z.string(),
    arch: z.string(),
  }),
  run: () => ({
    loupe: version,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
  }),
  format: (data) =>
    `loupe ${data.loupe} (node ${data.node}, ${data.platform} ${data.arch})`,
})
