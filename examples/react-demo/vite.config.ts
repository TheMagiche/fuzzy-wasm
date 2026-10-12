import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const fuseSrc = path.resolve(__dirname, '../../packages/fuse-wasm/src')

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: [
      { find: '@', replacement: path.resolve(__dirname, 'src') },
      { find: 'fuse-wasm/react', replacement: path.join(fuseSrc, 'react.tsx') },
      { find: 'fuse-wasm', replacement: path.join(fuseSrc, 'index.ts') },
    ],
  },
  server: {
    host: '127.0.0.1',
    port: 43123,
    strictPort: true,
    fs: { allow: [path.resolve(__dirname, '../..')] },
  },
  worker: { format: 'es' },
})
