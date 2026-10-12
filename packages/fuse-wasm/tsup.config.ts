import { readFileSync, writeFileSync } from 'node:fs'
import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    react: 'src/react.tsx',
    worker: 'src/worker.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  shims: true,
  external: ['react', 'react/jsx-runtime', 'react/jsx-dev-runtime'],
  async onSuccess() {
    for (const file of ['dist/index.js', 'dist/index.cjs', 'dist/react.js', 'dist/react.cjs']) {
      const text = readFileSync(file, 'utf8')
      if (text.includes('./worker.ts')) writeFileSync(file, text.replaceAll('./worker.ts', './worker.js'))
    }
  },
})
