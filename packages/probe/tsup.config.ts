import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
  },
  format: 'esm',
  // The code runs inside the app, not in Node.
  platform: 'neutral',
  target: 'es2022',
  esbuildOptions(options) {
    options.jsx = 'automatic'
  },
  outDir: 'dist',
  dts: true,
  clean: true,
  sourcemap: false,
})
