import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const at = (path: string): string => fileURLToPath(new URL(path, import.meta.url))

export default defineConfig({
  root: at('.'),
  plugins: [react()],
  // A new value at every build: the covers' addresses carry it (`cover-media.tsx`),
  // so after a deploy no browser keeps the old files for the day of cache.
  define: { __COVER_VERSION__: JSON.stringify(Date.now().toString(36)) },
  // 'hidden': the map stays in dist/ for debugging, but the bundle does not
  // point at it and deploy.sh does not publish it.
  build: { outDir: at('../dist/web'), emptyOutDir: true, sourcemap: 'hidden' },
  server: { port: 5190, proxy: { '^/(comfy-|plugin/|api|login)': 'http://127.0.0.1:3090' } },
})
