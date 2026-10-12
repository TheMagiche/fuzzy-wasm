import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const fuseSrc = path.resolve(__dirname, '../../packages/fuse-wasm/src')

/** Project-site prefix, e.g. `/fuzzy-wasm/`. Local dev stays at `/`. */
function siteBase(): string {
  const raw = process.env.VITE_BASE?.trim()
  if (!raw || raw === '/') return '/'
  const prefixed = raw.startsWith('/') ? raw : `/${raw}`
  return prefixed.endsWith('/') ? prefixed : `${prefixed}/`
}

export default defineConfig({
  base: siteBase(),
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
