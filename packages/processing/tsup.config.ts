import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    data: 'src/data/index.ts'
  },
  format: ['cjs'],
  platform: 'node',
  target: 'es2022',
  splitting: false,
  dts: false,
  clean: true
})
